import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { service } from '../server/service.ts'
import { digest } from '../server/store.ts'
import {
  newVaultKey,
  importVaultKey,
  encryptPrivate,
  decryptPrivate,
} from '../app/private-crypto.ts'
import { sealInput } from '../app/intake.ts'
test('two hosts, distinct agent approvals, host and agent revocation, private owner delegation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'host-private-')),
    origin = 'https://vault.example',
    api = service(dir, origin)
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const send = (
    url: string,
    body?: object,
    headers: Record<string, string> = {},
    method?: 'DELETE',
  ) =>
    api.inject({
      url,
      method: method || (body ? 'POST' : 'GET'),
      payload: body,
      headers: { 'openpassword-protocol-version': '1', ...headers },
    })
  const login = async (token: string) =>
    String((await send('/admin/login', { token })).headers['set-cookie']).split(';')[0]
  const owner = { cookie: await login(readFileSync(join(dir, 'operator.token'), 'utf8')) }
  const joe = {
    cookie: await login(
      (await send('/admin/members', { label: 'Joe', role: 'editor' }, owner)).json().token,
    ),
  }
  const privateState = (h: typeof owner) => send('/profile/vault', undefined, h)
  const info = (await privateState(joe)).json(),
    key = await importVaultKey(newVaultKey()),
    item = randomUUID()
  const ctx = (id: string) =>
    JSON.stringify(['OpenPassword.private.v1', info.tenant, info.profile, id])
  assert.equal(
    (
      await send(
        '/profile/vault',
        { check: await encryptPrivate(key, ctx('unlock'), 'OpenPassword private vault') },
        joe,
      )
    ).statusCode,
    200,
  )
  const sealed = await encryptPrivate(
    key,
    ctx(item),
    JSON.stringify({ title: 'Personal title', secret: 'private-value' }),
  )
  assert.equal(
    (await send('/profile/vault/items', { id: item, revision: 0, value: sealed }, joe)).statusCode,
    200,
  )
  assert.equal((await privateState(owner)).json().items.length, 0)
  const page = await privateState(joe)
  assert.doesNotMatch(page.body, /private-value|Personal title/)
  assert.equal(
    JSON.parse(await decryptPrivate(key, ctx(item), page.json().items[0].value)).secret,
    'private-value',
  )
  await assert.rejects(decryptPrivate(await importVaultKey(newVaultKey()), ctx(item), sealed))
  await assert.rejects(decryptPrivate(key, ctx(randomUUID()), sealed))
  const connection = await send(
    '/admin/connections',
    {
      private_source: item,
      label: 'Joe gateway',
      external_identity: 'demo',
      ownership: 'personal',
      provider: 'github_read',
      sealed: await sealInput('private-value', (await send('/admin/intake', {}, joe)).json()),
    },
    joe,
  )
  assert.equal(connection.statusCode, 200, connection.body)
  const conn = connection.json().connection_id
  assert.equal((await privateState(joe)).json().items[0].connections[0].id, conn)
  const grant = { connection_id: conn, label: 'Agent', operations: ['github.user.get'], hours: 1 }
  const standalone = (await send('/admin/grants', grant, joe)).json()
  const issueHost = async (label: string) => {
    const invite = (await send('/admin/hosts', { label }, owner)).json()
    const keys = generateKeyPairSync('ed25519')
    const params = { ticket: invite.ticket, key: keys.publicKey.export({ format: 'jwk' }).x }
    assert.equal((await send('/v1/hosts/enroll', params)).statusCode, 200)
    assert.equal((await send('/v1/hosts/enroll', params)).statusCode, 403)
    const signed = (path: string, body?: object, token = '') => {
      const time = String(Date.now()),
        nonce = randomBytes(16).toString('base64url'),
        auth = token ? 'Bearer ' + token : ''
      const fp = digest(
        JSON.stringify([
          origin,
          body ? 'POST' : 'GET',
          path,
          digest(auth),
          digest(body ? JSON.stringify(body) : ''),
        ]),
      )
      return {
        authorization: auth,
        'openpassword-host': [
          invite.id,
          time,
          nonce,
          sign(
            null,
            Buffer.from(['OpenPassword.host.1', invite.id, time, nonce, fp].join('.')),
            keys.privateKey,
          ).toString('base64url'),
        ].join('.'),
      }
    }
    return {
      id: invite.id,
      signed,
      call: (path: string, body?: object, token = '') =>
        send(path, body, signed(path, body, token)),
    }
  }
  assert.equal((await send('/admin/hosts', { label: 'x' }, joe)).statusCode, 403)
  const a = await issueHost('machine A'),
    b = await issueHost('machine B')
  assert.equal(
    (await send('/v1/whoami', undefined, { authorization: 'Bearer ' + standalone.access_token }))
      .statusCode,
    403,
  )
  assert.equal((await send('/admin/grants', grant, joe)).statusCode, 403)
  assert.equal((await a.call('/v1/hosts/self')).json().host_id, a.id)
  assert.equal((await a.call('/v1/whoami')).statusCode, 401)
  const enrollAgent = async (host: typeof a, label: string) => {
    const pair = (await host.call('/v1/device/authorizations', { device_name: label })).json()
    const body = { device_code: pair.device_code }
    assert.equal((await host.call('/v1/device/token', body)).statusCode, 428)
    assert.equal(
      (await send('/admin/grants', { ...grant, label, host_request: pair.pairing_id }, joe))
        .statusCode,
      200,
    )
    assert.equal((await send('/v1/device/token', body)).statusCode, 403)
    const result = await host.call('/v1/device/token', body)
    assert.equal(result.statusCode, 200, result.body)
    return result.json()
  }
  const one = await enrollAgent(a, 'Codex'),
    two = await enrollAgent(a, 'Claude'),
    three = await enrollAgent(b, 'Codex')
  const who = '/v1/whoami',
    headers = a.signed(who, undefined, one.access_token)
  assert.equal((await send(who, undefined, headers)).statusCode, 200)
  assert.equal((await send(who, undefined, headers)).statusCode, 403)
  assert.equal((await b.call(who, undefined, one.access_token)).statusCode, 403)
  assert.equal(
    (await send('/v1/device/token/refresh', { refresh_token: one.refresh_token })).statusCode,
    403,
  )
  assert.equal(
    (await send('/admin/grants/' + one.device_id, undefined, joe, 'DELETE')).statusCode,
    200,
  )
  assert.equal((await a.call(who, undefined, two.access_token)).statusCode, 200)
  assert.equal((await send('/admin/hosts/' + a.id, undefined, owner, 'DELETE')).statusCode, 200)
  assert.equal((await a.call(who, undefined, two.access_token)).statusCode, 403)
  assert.equal((await b.call(who, undefined, three.access_token)).statusCode, 200)
})

test('fresh deployed policy requires hosts before the first enrollment and survives restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (let i = 0; i < 2; i++) {
    const api = service(dir, undefined, undefined, undefined, true)
    try {
      const login = await api.inject({
        method: 'POST',
        url: '/admin/login',
        payload: { token: readFileSync(join(dir, 'operator.token'), 'utf8') },
      })
      const cookie = String(login.headers['set-cookie']).split(';')[0]
      const ws = await api.inject({ url: '/admin/workspace', headers: { cookie } })
      assert.equal(ws.json().managed_hosts, true)
    } finally {
      await api.close()
    }
  }
})
