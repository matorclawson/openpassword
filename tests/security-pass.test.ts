import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { service } from '../server/service.ts'
import {
  newVaultKey,
  derivePrivateKey,
  encryptPrivate,
  decryptPrivate,
  openPrivateValue,
  sealPrivateItem,
  importVaultKey,
} from '../app/private-crypto.ts'

test('new vault needs both unlock factors, contexts bind keys and legacy items remain readable', async () => {
  const secret = newVaultKey(),
    pass = 'fixture passphrase'
  const key = await derivePrivateKey(secret, pass, 'tenant', 'joe')
  const value = await sealPrivateItem(key, 'item', 'field', 'fixture', 'synthetic secret')
  const item = JSON.parse(await decryptPrivate(key, 'item', value))
  assert.equal(await openPrivateValue(key, 'field', item), 'synthetic secret')
  for (const wrong of [
    await derivePrivateKey(secret, 'different', 'tenant', 'joe'),
    await derivePrivateKey(newVaultKey(), pass, 'tenant', 'joe'),
    await derivePrivateKey(secret, pass, 'tenant', 'jane'),
    await importVaultKey(secret),
  ]) {
    await assert.rejects(decryptPrivate(wrong, 'item', value))
  }
  await assert.rejects(openPrivateValue(key, 'other field', item))
  assert.equal(
    await openPrivateValue(key, 'field', {
      protectedValue: await encryptPrivate(key, 'field', 'legacy'),
    }),
    'legacy',
  )
})
test('CLI deposits exactly the prepared ciphertext once, without a vault session or decrypting key', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'security-deposit-')),
    api = service(dir)
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
      headers: { cookie, 'openpassword-protocol-version': '1' },
    })
  const login = await post('/admin/login', {
    token: readFileSync(join(dir, 'operator.token'), 'utf8'),
  })
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  const key = await importVaultKey(newVaultKey())
  const check = await encryptPrivate(key, 'unlock', 'OpenPassword private vault')
  assert.equal((await post('/profile/vault', { check }, cookie)).statusCode, 200)
  const id = crypto.randomUUID(),
    value = await sealPrivateItem(key, id, 'field', 'item name', 'secret fixture')
  assert.equal((await post('/profile/vault/deposits', { id, value })).statusCode, 401)
  const { ticket } = (await post('/profile/vault/deposits', { id, value }, cookie)).json()
  const child = execFile(
    process.execPath,
    [resolve('packages/cli/dist/index.js'), 'vault-deposit'],
    { env: { ...process.env, HOME: dir, OPENPASSWORD_BROKER: origin } },
  )
  const output = once(child.stdout!, 'data'),
    exit = once(child, 'exit')
  child.stdin!.end(ticket + '\n')
  assert.equal(String((await output)[0]).trim(), 'Private item saved')
  assert.equal((await exit)[0], 0)
  assert.equal((await post('/v1/vault/deposits', { ticket })).statusCode, 409)
  const view = await api.inject({ url: '/profile/vault', headers: { cookie } })
  assert.equal(view.json().items[0].value, value)
  assert.doesNotMatch(view.body, /secret fixture|item name/)
  const expired = (
    await post('/profile/vault/deposits', { id: crypto.randomUUID(), value }, cookie)
  ).json()
  const db = new DatabaseSync(join(dir, 'vault.sqlite'))
  try {
    db.prepare('UPDATE private_deposits SET expires=0').run()
  } finally {
    db.close()
  }
  assert.equal((await post('/v1/vault/deposits', expired)).statusCode, 409)
  const other = (
    await post('/profile/vault/deposits', { id: crypto.randomUUID(), value }, cookie)
  ).json()
  await post('/admin/logout', {}, cookie)
  assert.equal((await post('/v1/vault/deposits', other)).statusCode, 409)
})
test('workstation update verifies a separately pinned signing key before execution', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-signing-')),
    bin = join(dir, 'bin'),
    client = join(dir, 'client')
  const keys = generateKeyPairSync('ed25519')
  writeFileSync(join(dir, 'key'), keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    mode: 0o600,
  })
  writeFileSync(join(dir, 'pub'), keys.publicKey.export({ format: 'pem', type: 'spki' }))
  let bytes = Buffer.from('#!/usr/bin/env node\nconsole.log("fixture")\n')
  writeFileSync(client, bytes)
  const run = promisify(execFile)
  await run(process.execPath, [
    'scripts/sign-client.ts',
    join(dir, 'key'),
    client,
    join(dir, 'sig'),
  ])
  const server = createServer((req, res) =>
    res.end(
      req.url?.endsWith('.sig')
        ? readFileSync(join(dir, 'sig'))
        : req.url?.endsWith('.sha256')
          ? createHash('sha256').update(bytes).digest('hex')
          : bytes,
    ),
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })
  const env = {
    ...process.env,
    OPENPASSWORD_BIN_DIR: bin,
    OPENPASSWORD_BROKER: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    OPENPASSWORD_CLI_SHA256: '',
    OPENPASSWORD_CLI_PUBLIC_KEY: '',
  }
  await assert.rejects(run('sh', ['deploy/update-client.sh'], { env }))
  assert.ok(!existsSync(join(bin, 'openpassword')))
  delete (env as Partial<typeof env>).OPENPASSWORD_CLI_SHA256
  env.OPENPASSWORD_CLI_PUBLIC_KEY = join(dir, 'pub')
  await run('sh', ['deploy/update-client.sh'], { env })
  const installed = readFileSync(join(bin, 'openpassword'))
  bytes = Buffer.from('console.log("updated fixture")')
  await assert.rejects(run('sh', ['deploy/update-client.sh'], { env }))
  assert.deepEqual(readFileSync(join(bin, 'openpassword')), installed)
})

test('revocation during a buffered model request suppresses the response', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'security-model-'))
  const arrived = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const api = service(dir, undefined, async () => {
    arrived.resolve()
    await release.promise
    return Response.json({ choices: [{ message: { content: 'fixture-output' } }] })
  })
  t.after(async () => {
    release.resolve()
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    api.inject({ method: 'POST', url, payload, headers })
  const cookie = String(
    (await post('/admin/login', { token: readFileSync(join(dir, 'operator.token'), 'utf8') }))
      .headers['set-cookie'],
  ).split(';')[0]
  const c = (
    await post(
      '/admin/connections',
      {
        provider: 'openai',
        label: 'Provider',
        external_identity: 'fixture',
        secret: 'fixture-key',
      },
      { cookie },
    )
  ).json()
  const g = (
    await post(
      '/admin/grants',
      {
        label: 'agent',
        connection_id: c.connection_id,
        operations: ['openai.chat'],
        hours: 1,
        model_lease: { model: 'fixture', calls: 1, max_tokens: 5 },
      },
      { cookie },
    )
  ).json()
  const response = post(
    '/v1/chat/completions',
    { model: 'fixture', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] },
    { authorization: 'Bearer ' + g.access_token },
  ).then((r) => r)
  await arrived.promise
  await api.inject({ method: 'DELETE', url: '/admin/grants/' + g.device_id, headers: { cookie } })
  release.resolve()
  const result = await response
  assert.equal(result.statusCode, 502)
  assert.doesNotMatch(result.body, /fixture-output|fixture-key/)
})
