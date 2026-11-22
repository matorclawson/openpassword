import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'
import { providers, buildRequest } from '../packages/connectors/index.ts'

test('device lease, exact approval, replay, account isolation, rotation and restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-test-'))
  let sends = 0
  const send: typeof fetch = async (url, init) => {
    sends++
    assert.equal(new URL(String(url)).origin, 'https://api.x.com')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-secret-example')
    return Response.json({ data: { id: '123' } })
  }
  let app = service(dir, undefined, send)
  t.after(async () => {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  })
  let cookie = '',
    bearer = ''
  const call = async (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: object,
    expected = 200,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url,
      payload,
      headers: {
        'zeoconnect-protocol-version': '1',
        cookie,
        authorization: 'Bearer ' + bearer,
        ...headers,
      },
    })
    assert.equal(res.statusCode, expected, res.body)
    return res
  }
  const login = await call('POST', '/admin/login', {
    token: readFileSync(join(dir, 'operator.token'), 'utf8'),
  })
  cookie = String(login.headers['set-cookie']).split(';')[0]
  await call('POST', '/admin/workspaces', { label: 'forbidden' }, 403, {
    origin: 'https://example.invalid',
  })
  const c = (
    await call('POST', '/admin/connections', {
      provider: 'x',
      label: 'News',
      external_identity: 'example',
      secret: 'test-secret-example',
    })
  ).json().connection_id
  const pair = (
    await call('POST', '/v1/device/authorizations', { device_name: 'Editorial CLI' })
  ).json()
  await call('POST', '/v1/device/token', { device_code: pair.device_code }, 428)
  const grant = (
    await call('POST', '/admin/grants', {
      label: 'Editorial CLI',
      connection_id: c,
      operations: ['x.publish'],
      hours: 2,
      user_code: pair.user_code,
    })
  ).json()
  const device = (await call('POST', '/v1/device/token', { device_code: pair.device_code })).json()
  await call('POST', '/v1/device/token', { device_code: pair.device_code }, 400)
  bearer = device.access_token
  const list = (await call('GET', '/v1/connections')).json()
  assert.equal(list.length, 1)
  assert.equal(list[0].connection_revision, undefined)
  const hdr = { 'zeoconnect-capabilities': 'expected-binding' }
  assert.equal(
    (await call('GET', '/v1/connections', undefined, 200, hdr)).json()[0].connection_revision,
    '1',
  )
  const url = '/v1/operations/x.publish:invoke',
    body = {
      connection_id: c,
      operation_id: 'x.publish',
      idempotency_key: 'post-1',
      arguments: { text: 'Example' },
      expect: { external_identity: 'example', connection_revision: '1' },
    }
  const first = (await call('POST', url, body, 200, hdr)).json()
  assert.equal(first.status, 'approval_required')
  assert.equal(sends, 0)
  const w = (await call('POST', '/admin/workspaces', { label: 'Second workspace' })).json()
  await call('POST', '/admin/switch', w)
  const other = (await call('GET', '/admin/workspace')).json()
  assert.equal(other.connections.length, 0)
  assert.equal(other.approvals.length, 0)
  await call('POST', '/admin/approvals/' + first.execution_id, { approve: true }, 409)
  await call('POST', '/admin/switch', { id: 'default' })
  await call('POST', '/admin/approvals/' + first.execution_id, { approve: true })
  const outcomes = await Promise.all([
    call('POST', url, body, 200, hdr),
    call('POST', url, body, 200, hdr),
  ])
  assert.equal(outcomes[0].json().status, 'confirmed')
  assert.equal(sends, 1)
  await app.close()
  app = service(dir, undefined, send)
  assert.equal((await call('POST', url, body, 200, hdr)).json().receipt.replayed, true)
  assert.equal(sends, 1)
  await call('POST', url, { ...body, arguments: { text: 'different' } }, 400, hdr)
  await call('POST', '/admin/connections/' + c + '/rotate', { secret: 'rotated-example' })
  await call('POST', url, { ...body, idempotency_key: 'post-2' }, 400, hdr)
  const rotated = (
    await call('POST', '/v1/device/token/refresh', { refresh_token: device.refresh_token })
  ).json()
  await call('GET', '/v1/connections', undefined, 401)
  bearer = rotated.access_token
  await call('POST', '/v1/device/token/refresh', { refresh_token: device.refresh_token }, 401)
  await call('DELETE', '/admin/grants/' + grant.device_id)
  await call('GET', '/v1/connections', undefined, 401)
  for (const file of ['vault.sqlite', 'vault.sqlite-wal'])
    assert.equal(readFileSync(join(dir, file)).includes('test-secret-example'), false)
})
for (const [id, p] of Object.entries(providers))
  test(id + ' builds all registered operations', () => {
    for (const a of p.actions) {
      const params = Array.from(a.path.matchAll(/\{(\w+)\}/g), (m) => m[1])
      const args = Object.fromEntries([...a.required, ...params].map((k) => [k, 'sample']))
      if (id === 'google_sheets')
        Object.assign(args, {
          spreadsheet_id: 'a'.repeat(24),
          ...(a.id === 'sheets.batch_get' ? { ranges: ['Sheet!A1'] } : { range: 'Sheet!A1' }),
          ...(a.id === 'sheets.append_rows'
            ? { rows: [[1]] }
            : a.id === 'sheets.update_range'
              ? { values: [[1]] }
              : {}),
        })
      const r = buildRequest(
        id,
        a.id,
        args,
        id === 'supabase_data'
          ? JSON.stringify({ project: 'a'.repeat(20), key: 'example' })
          : id === 'twilio'
            ? 'AC' + '0'.repeat(32) + ':example'
            : 'example',
      )
      assert.equal(r.url.protocol, 'https:')
      assert.equal(r.init.redirect, 'error')
      assert.throws(() =>
        buildRequest(id, a.id, { ...args, url: 'https://example.invalid' }, 'token'),
      )
    }
  })
