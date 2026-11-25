import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { service } from '../server/service.ts'
import { LocalAgent } from '../packages/client/local.ts'
import { targets } from '../packages/cli/harness.ts'

test('local harness launchers preserve profiles, exact connection binding and revocation', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'op-adapters-'))
  const api = service(home, undefined, async () => Response.json({ login: 'fixture', id: 1 }))
  t.after(async () => {
    await api.close()
    rmSync(home, { recursive: true, force: true })
  })
  const origin = await api.listen({ host: '127.0.0.1', port: 0 })
  const env = {
    NODE_ENV: 'test' as const,
    HOME: home,
    OPENPASSWORD_BROKER: origin,
    OPENPASSWORD_AGENT: 'unit-codex',
    PATH: process.env.PATH,
  }
  function run(
    bin: string,
    args: string[],
    input = '',
    extra: Record<string, string> = {},
  ): Promise<string> {
    return new Promise((ok, fail) => {
      const child = execFile(bin, args, { env: { ...env, ...extra } }, (err, out, stderr) =>
        err ? fail(Error(stderr)) : ok(out.trim()),
      )
      child.stdin!.on('error', () => {})
      child.stdin!.end(input)
    })
  }
  const cli = (args: string[], input = '', extra = {}) =>
    run(process.execPath, [resolve('packages/cli/dist/index.js'), ...args], input, extra)
  const post = (url: string, payload: object, cookie = '') =>
    api.inject({ method: 'POST', url, payload, headers: { cookie } })
  const cookie = String(
    (await post('/admin/login', { token: readFileSync(join(home, 'operator.token'), 'utf8') }))
      .headers['set-cookie'],
  ).split(';')[0]
  const c = (
    await post(
      '/admin/connections',
      {
        provider: 'github_read',
        label: 'GitHub',
        external_identity: 'fixture',
        secret: 'fake-upstream',
      },
      cookie,
    )
  ).json().connection_id
  const grant = (
    await post(
      '/admin/grants',
      {
        label: 'codex',
        connection_id: c,
        operations: ['github.user.get'],
        hours: 1,
        enrollment: true,
      },
      cookie,
    )
  ).json()
  await cli(['connect'], grant.enrollment_token + '\n')
  const absent = join(home, 'missing.sock')
  const signed = await cli(['harness', 'prepare', 'codex', join(home, 'signed')], '', {
    OPENPASSWORD_HOST_SOCKET: absent,
  })
  await assert.rejects(run(signed, ['whoami']))
  await assert.rejects(cli(['harness', 'prepare', 'codex', join(home, 'bad')]))
  for (const target of targets) {
    const root = join(home, "agent's configs", target)
    const adapter = await cli(['harness', 'prepare', target, root, '--standalone'])
    const who = JSON.parse(
      await run(adapter, ['whoami'], '', {
        OPENPASSWORD_AGENT: 'wrong',
        OPENPASSWORD_BROKER: 'http://127.0.0.1:1',
      }),
    )
    assert.equal(who.device_id, grant.device_id)
    assert.equal(who.connection_id, c)
    assert.equal(readFileSync(adapter, 'utf8').includes(grant.enrollment_token), false)
    await assert.rejects(run(adapter, ['host', 'connect']))
  }
  const adapter = join(home, "agent's configs", 'codex', 'openpassword-agent')
  await assert.rejects(
    cli(['harness', 'prepare', 'codex', join(home, "agent's configs", 'codex'), '--standalone']),
  )
  assert.match(await run(adapter, ['operation', 'github.user.get', 'read-1'], '{}'), /fixture/)
  await assert.rejects(run(adapter, ['operation', 'some.other.op', 'read-2'], '{}'), /unavailable/)
  await assert.rejects(
    run(adapter, ['invoke-json'], 'private-bad-input'),
    (e) => !String(e).includes('private-bad-input'),
  )
  const client = new LocalAgent(adapter)
  assert.equal(((await client.whoami()) as { device_id: string }).device_id, grant.device_id)
  assert.match(
    JSON.stringify(await client.operation('github.user.get', {}, 'node-local-test')),
    /fixture/,
  )
  if (process.env.OPENPASSWORD_FRAMEWORK_PYTHON) {
    assert.match(
      await run(
        process.env.OPENPASSWORD_FRAMEWORK_PYTHON,
        [resolve('tests/harness-frameworks.py')],
        '',
        {
          OPENPASSWORD_ADAPTER: adapter,
          PYTHONDONTWRITEBYTECODE: '1',
        },
      ),
      /framework checks passed/,
    )
  }
  await api.inject({
    method: 'DELETE',
    url: '/admin/grants/' + grant.device_id,
    headers: { cookie },
  })
  await assert.rejects(client.whoami())
})
