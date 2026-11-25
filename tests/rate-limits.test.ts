import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service, trustedProxies } from '../server/service.ts'

const hdr = { 'openpassword-protocol-version': '1', 'content-type': 'application/json' }
function setup(t: test.TestContext, limits: Parameters<typeof service>[5] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'op-rate-')),
    api = service(dir, undefined, fetch, false, false, limits)
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, api }
}
// Pairing starts are limited to 60 a minute per source address and path.
async function pairing(
  api: ReturnType<typeof service>,
  remoteAddress: string,
  forwarded?: string,
) {
  return api.inject({
    method: 'POST',
    url: '/v1/device/authorizations',
    remoteAddress,
    headers: { ...hdr, ...(forwarded ? { 'x-forwarded-for': forwarded } : {}) },
    payload: { device_name: 'Test device' },
  })
}

test('trusted proxy settings accept proxy addresses and refuse anything that trusts everyone', () => {
  assert.equal(trustedProxies(undefined), undefined)
  assert.equal(trustedProxies(''), undefined)
  assert.deepEqual(trustedProxies('127.0.0.1'), ['127.0.0.1'])
  assert.deepEqual(trustedProxies('127.0.0.1, ::1, 10.0.0.0/8'), ['127.0.0.1', '::1', '10.0.0.0/8'])
  for (const bad of ['true', '*', '1', '2', '0.0.0.0/0', '::/0', '10.0.0.0/7', '127.0.0.1/33', 'example.com', '127.0.0.1,', '10.0.0.0/8/8'])
    assert.throws(() => trustedProxies(bad), /OPENPASSWORD_TRUST_PROXY/, bad)
})

test('without a trusted proxy every client behind the proxy shares one bucket and a forwarded address is ignored', async (t) => {
  const { api } = setup(t)
  for (let i = 0; i < 60; i++)
    assert.equal((await pairing(api, '127.0.0.1', '203.0.113.' + (i + 1))).statusCode, 200)
  const res = await pairing(api, '127.0.0.1', '203.0.113.200')
  assert.equal(res.statusCode, 429)
  assert.equal(res.json().detail, 'Try again in one minute')
})

test('a trusted loopback proxy makes the limit per client address', async (t) => {
  const { api } = setup(t, { trustProxy: '127.0.0.1' })
  for (let i = 0; i < 60; i++)
    assert.equal((await pairing(api, '127.0.0.1', '203.0.113.7')).statusCode, 200)
  assert.equal((await pairing(api, '127.0.0.1', '203.0.113.7')).statusCode, 429)
  // Another client behind the same proxy is unaffected.
  assert.equal((await pairing(api, '127.0.0.1', '203.0.113.8')).statusCode, 200)
  // A chain through the console's own hop (client, proxy) still resolves to the client.
  assert.equal((await pairing(api, '127.0.0.1', '203.0.113.7, 127.0.0.1')).statusCode, 429)
  assert.equal((await pairing(api, '127.0.0.1', '203.0.113.9, 127.0.0.1')).statusCode, 200)
})

test('a forwarded address from a peer that is not a trusted proxy is ignored', async (t) => {
  const { api } = setup(t, { trustProxy: '127.0.0.1' })
  // The peer is 198.51.100.7, not 127.0.0.1: changing X-Forwarded-For must not give it a fresh bucket.
  for (let i = 0; i < 60; i++)
    assert.equal((await pairing(api, '198.51.100.7', '203.0.113.' + (i + 1))).statusCode, 200)
  assert.equal((await pairing(api, '198.51.100.7', '203.0.113.250')).statusCode, 429)
  assert.equal((await pairing(api, '198.51.100.7')).statusCode, 429)
  // A different real peer has its own bucket.
  assert.equal((await pairing(api, '198.51.100.8', '203.0.113.1')).statusCode, 200)
})

test('the per-grant ceiling counts authenticated requests once, per grant, and not bad credentials', async (t) => {
  const { dir, api } = setup(t, { grantPerMinute: 5 })
  let cookie = ''
  const call = async (method: 'GET' | 'POST', url: string, payload?: object, bearer?: string) =>
    api.inject({
      method,
      url,
      payload,
      headers: { ...hdr, cookie, ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
    })
  const login = await call('POST', '/admin/login', {
    token: readFileSync(join(dir, 'operator.token'), 'utf8'),
  })
  assert.equal(login.statusCode, 200, login.body)
  cookie = String(login.headers['set-cookie']).split(';')[0]
  const connection = (
    await call('POST', '/admin/connections', {
      provider: 'x',
      label: 'News',
      external_identity: 'example',
      secret: 'test-secret-example',
    })
  ).json().connection_id
  async function device(label: string) {
    const pair = (await call('POST', '/v1/device/authorizations', { device_name: label })).json()
    const grant = await call('POST', '/admin/grants', {
      label,
      connection_id: connection,
      operations: ['x.publish'],
      hours: 2,
      user_code: pair.user_code,
    })
    assert.equal(grant.statusCode, 200, grant.body)
    const token = await call('POST', '/v1/device/token', { device_code: pair.device_code })
    assert.equal(token.statusCode, 200, token.body)
    return token.json().access_token as string
  }
  const first = await device('First'),
    second = await device('Second')
  for (let i = 0; i < 5; i++) assert.equal((await call('GET', '/v1/connections', undefined, first)).statusCode, 200)
  const over = await call('GET', '/v1/connections', undefined, first)
  assert.equal(over.statusCode, 429)
  assert.equal(over.json().detail, 'Try again in one minute')
  // The other grant has its own budget.
  assert.equal((await call('GET', '/v1/connections', undefined, second)).statusCode, 200)
  // Bad credentials are refused as before and do not spend a grant's budget.
  for (let i = 0; i < 10; i++)
    assert.equal((await call('GET', '/v1/connections', undefined, 'not-a-real-token')).statusCode, 401)
  for (let i = 0; i < 4; i++) assert.equal((await call('GET', '/v1/connections', undefined, second)).statusCode, 200)
  assert.equal((await call('GET', '/v1/connections', undefined, second)).statusCode, 429)
})

test('the per-grant ceiling can be turned off and is validated', async (t) => {
  assert.throws(() => service(mkdtempSync(join(tmpdir(), 'op-rate-bad-')), undefined, fetch, false, false, { grantPerMinute: -1 }), /OPENPASSWORD_GRANT_RATE/)
  assert.throws(() => service(mkdtempSync(join(tmpdir(), 'op-rate-bad-')), undefined, fetch, false, false, { grantPerMinute: 1.5 }), /OPENPASSWORD_GRANT_RATE/)
  const { api } = setup(t, { grantPerMinute: 0 })
  assert.equal((await pairing(api, '127.0.0.1')).statusCode, 200)
})
