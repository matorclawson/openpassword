import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { service } from '../server/service.ts'

test('web-issued tickets bind separate CLI and MCP profiles and cannot be replayed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-enroll-'))
  const api = service(dir, undefined, async () =>
    Response.json({
      choices: [{ message: { role: 'assistant', content: 'fixture response' } }],
      usage: { prompt_tokens: 2, completion_tokens: 2 },
    }),
  )
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const origin = await api.listen({ host: '127.0.0.1', port: 0 })
  const post = (url: string, payload: object, cookie = '') =>
    api.inject({
      method: 'POST',
      url,
      payload,
      headers: { cookie, 'OpenPassword-Protocol-Version': '1' },
    })
  const owner = await post('/auth/setup', {
    token: readFileSync(join(dir, 'operator.token'), 'utf8'),
    username: 'tester',
    password: 'test-only-password',
  })
  assert.equal(owner.statusCode, 200, owner.body)
  const cookie = String(owner.headers['set-cookie']).split(';')[0]
  const c = (
    await post(
      '/admin/connections',
      {
        provider: 'github_read',
        label: 'Test',
        external_identity: 'example',
        secret: 'private-fixture',
      },
      cookie,
    )
  ).json()
  const make = async (label: string) =>
    (
      await post(
        '/admin/grants',
        {
          connection_id: c.connection_id,
          operations: ['github.user.get'],
          label,
          hours: 1,
          enrollment: true,
        },
        cookie,
      )
    ).json()
  const cli = resolve(process.env.OPENPASSWORD_TEST_CLI || 'packages/cli/dist/index.js')
  async function connect(label: string, ticket: string) {
    const env = { HOME: dir, OPENPASSWORD_AGENT: label, OPENPASSWORD_BROKER: origin }
    const child = spawn(process.execPath, [cli, 'connect'], { env: { ...env, NODE_ENV: 'test' } })
    let out = '',
      error = ''
    child.stdout.on('data', (b) => (out += b))
    child.stderr.on('data', (b) => (error += b))
    const done = new Promise((resolve) => child.on('close', resolve))
    child.stdin.end(ticket + '\n')
    assert.equal(await done, 0, error)
    return { env, identity: JSON.parse(out) }
  }
  const profiles = await Promise.all(
    ['local-codex', 'remote-claude'].map(async (label) => {
      const ticket = await make(label)
      assert.ok(ticket.enrollment_token && !ticket.access_token)
      const profile = await connect(label, ticket.enrollment_token)
      assert.equal(profile.identity.device_id, ticket.device_id)
      assert.equal(
        (await post('/v1/device/token', { device_code: ticket.enrollment_token })).statusCode,
        400,
      )
      return profile
    }),
  )
  await Promise.all(
    profiles.map(async (p) => {
      const client = new Client({ name: 'profile-test', version: '1' })
      try {
        await client.connect(
          new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: p.env }),
        )
        const read = async (name: string) =>
          JSON.parse(
            ((await client.callTool({ name, arguments: {} })).content as { text: string }[])[0]
              .text,
          )
        assert.equal((await read('whoami')).device_id, p.identity.device_id)
        const events = (await read('activity')).events
        assert.deepEqual(
          events.map((e: { actor: string }) => e.actor),
          [p.identity.device_id],
        )
      } finally {
        await client.close()
      }
    }),
  )
  const modelConn = (
    await post(
      '/admin/connections',
      {
        provider: 'openai',
        label: 'Inference',
        external_identity: 'fixture',
        secret: 'fixture-key',
      },
      cookie,
    )
  ).json()
  const modelTicket = (
    await post(
      '/admin/grants',
      {
        label: 'inference',
        connection_id: modelConn.connection_id,
        operations: ['openai.chat'],
        hours: 1,
        enrollment: true,
        model_lease: { model: 'fixture-model', max_tokens: 10, calls: 2 },
      },
      cookie,
    )
  ).json()
  const { env } = await connect('inference', modelTicket.enrollment_token)
  const cliChat = spawn(process.execPath, [cli, 'chat', 'fixture-model', '5', 'cli-call'], {
    env: { ...env, NODE_ENV: 'test' },
  })
  let response = ''
  cliChat.stdout.on('data', (d) => (response += d))
  const done = new Promise((resolve) => cliChat.on('close', resolve))
  cliChat.stdin.end('Hello')
  assert.equal(await done, 0)
  assert.match(response, /fixture response/)
  const modelClient = new Client({ name: 'model-test', version: '1' })
  try {
    await modelClient.connect(
      new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env }),
    )
    const models = await modelClient.callTool({ name: 'models', arguments: {} })
    assert.match(JSON.stringify(models.content), /fixture-model/)
    const request = {
      name: 'chat',
      arguments: {
        model: 'fixture-model',
        max_tokens: 5,
        prompt: 'Hello',
        idempotency_key: 'mcp-call',
      },
    }
    assert.match(JSON.stringify((await modelClient.callTool(request)).content), /fixture response/)
    assert.ok((await modelClient.callTool(request)).isError)
  } finally {
    await modelClient.close()
  }
  const revoked = await make('revoked')
  await api.inject({
    method: 'DELETE',
    url: '/admin/grants/' + revoked.device_id,
    headers: { cookie },
  })
  assert.equal(
    (await post('/v1/device/token', { device_code: revoked.enrollment_token })).statusCode,
    403,
  )
  const expired = await make('expired')
  const db = new DatabaseSync(join(dir, 'vault.sqlite'))
  db.prepare('UPDATE pairs SET expires=0 WHERE grant_id=?').run(expired.device_id)
  db.close()
  assert.equal(
    (await post('/v1/device/token', { device_code: expired.enrollment_token })).statusCode,
    400,
  )
})

test('activity cursor survives reopen, isolates audiences, and checks authorization again after waking', async () => {
  const { activity } = await import('../server/activity.ts')
  const dir = mkdtempSync(join(tmpdir(), 'op-feed-'))
  const path = join(dir, 'history.sqlite')
  let db = new DatabaseSync(path)
  try {
    db.exec(
      'CREATE TABLE events(id INTEGER PRIMARY KEY,tenant TEXT,action TEXT,subject TEXT,at INTEGER,actor TEXT)',
    )
    let feed = activity(db)
    const scope = { tenant: 'org', actor: 'a' }
    const controller = new AbortController()
    const poll = (after: number, wait = 0) => feed.poll(() => scope, after, controller.signal, wait)
    const insert = (tenant: string, actor: string) => {
      db.prepare('INSERT INTO events(tenant,actor,action,subject,at) VALUES(?,?,?,?,?)').run(
        tenant,
        actor,
        'Used',
        'credential',
        Date.now(),
      )
      feed.signal(tenant, actor)
    }
    const waiting = poll(0, 1000)
    insert('elsewhere', 'a')
    insert('org', 'b')
    insert('org', 'a')
    assert.deepEqual(
      (await waiting).events.map((e) => e.id),
      [3],
    )
    let authorized = true
    const pending = feed.poll(
      () => {
        if (!authorized) throw Error('revoked')
        return scope
      },
      3,
      controller.signal,
      1000,
    )
    authorized = false
    insert('org', 'a')
    await assert.rejects(pending, /revoked/)
    db.close()
    db = new DatabaseSync(path)
    feed = activity(db)
    assert.deepEqual(
      (await poll(3)).events.map((e) => e.id),
      [4],
    )
    const idle = Array.from({ length: 512 }, () => poll(4, 20000))
    await assert.rejects(poll(4, 20000), /limit/)
    controller.abort()
    await Promise.all(idle)
    assert.equal((await feed.poll(() => scope, 4, new AbortController().signal, 1)).cursor, 4)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
