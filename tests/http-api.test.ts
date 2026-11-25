import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'

test('plain HTTP pairs a signed agent, discovers, invokes, rotates and revokes', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'openpassword-http-'))
  const origin = 'https://vault.example'
  let calls = 0
  const broker = service(
    home,
    origin,
    async () => {
      calls++
      return Response.json({ login: 'rest-example', id: 1 })
    },
    false,
    true,
  )
  t.after(async () => {
    await broker.close()
    rmSync(home, { recursive: true, force: true })
  })
  const listener = await broker.listen({ host: '127.0.0.1', port: 0 })
  const spec = await (await fetch(listener + '/v1/openapi.json')).json()
  assert.equal(spec.openapi, '3.1.0')
  assert.ok(spec.paths['/v1/operations/{operation_id}:invoke'].post.requestBody)
  assert.equal((await fetch(listener + '/v1/whoami')).status, 426)
  const post = (url: string, payload: object, cookie = '') =>
    broker.inject({ method: 'POST', url, payload, headers: { cookie } })
  const cookie = String(
    (await post('/admin/login', { token: readFileSync(join(home, 'operator.token'), 'utf8') }))
      .headers['set-cookie'],
  ).split(';')[0]
  const connection = (
    await post(
      '/admin/connections',
      {
        provider: 'github_read',
        label: 'HTTP',
        external_identity: 'rest-example',
        secret: 'test-only',
      },
      cookie,
    )
  ).json()
  const host = (await post('/admin/hosts', { label: 'HTTP' }, cookie)).json()
  const keys = generateKeyPairSync('ed25519')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  function send(path: string, payload?: object, token = '', signed = true) {
    const method = payload ? 'POST' : 'GET',
      body = payload ? JSON.stringify(payload) : undefined,
      authorization = token ? 'Bearer ' + token : ''
    const fp = hash(JSON.stringify([origin, method, path, hash(authorization), hash(body || '')]))
    const parts = [host.id, String(Date.now()), randomBytes(16).toString('base64url')]
    const signature = sign(
      null,
      Buffer.from(['OpenPassword.host.1', ...parts, fp].join('.')),
      keys.privateKey,
    ).toString('base64url')
    return fetch(listener + path, {
      method,
      body,
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        'OpenPassword-Protocol-Version': '1',
        'OpenPassword-Capabilities': 'expected-binding',
        ...(signed ? { 'OpenPassword-Host': [...parts, signature].join('.') } : {}),
      },
    })
  }
  assert.equal(
    (
      await send(
        '/v1/hosts/enroll',
        { ticket: host.ticket, key: keys.publicKey.export({ format: 'jwk' }).x },
        '',
        false,
      )
    ).status,
    200,
  )
  const pair = await (await send('/v1/device/authorizations', { device_name: 'raw HTTP' })).json()
  const exchange = () => send('/v1/device/token', { device_code: pair.device_code })
  assert.equal((await exchange()).status, 428)
  assert.equal(
    (
      await post(
        '/admin/grants',
        {
          label: 'raw HTTP',
          host_request: pair.pairing_id,
          connection_id: connection.connection_id,
          operations: ['github.user.get'],
          hours: 1,
        },
        cookie,
      )
    ).statusCode,
    200,
  )
  const tokens = await (await exchange()).json()
  const token = tokens.access_token
  assert.equal((await send('/v1/whoami', undefined, token, false)).status, 403)
  const caps = await (await send('/v1/capabilities', undefined, token)).json()
  const data = {
    connection_id: caps.connection_id,
    operation_id: 'github.user.get',
    arguments: {},
    idempotency_key: 'rest-read',
    expect: {
      connection_revision: caps.connection_revision,
      external_identity: caps.external_identity,
    },
  }
  const invoke = '/v1/operations/github.user.get:invoke'
  assert.equal((await send(invoke, { ...data, connection_id: 'other' }, token)).status, 403)
  const result = await (await send(invoke, data, token)).json()
  assert.equal(result.result.login, 'rest-example')
  assert.equal((await (await send(invoke, data, token)).json()).status, 'confirmed')
  assert.equal(calls, 1)
  assert.ok((await (await send('/v1/activity?wait=0', undefined, token)).json()).events.length)
  const rotated = await (
    await send('/v1/device/token/refresh', { refresh_token: tokens.refresh_token })
  ).json()
  assert.equal((await send('/v1/whoami', undefined, token)).status, 401)
  assert.equal((await send('/v1/device/revoke', {}, rotated.access_token)).status, 204)
  assert.equal((await send('/v1/models', undefined, rotated.access_token)).status, 401)
})
