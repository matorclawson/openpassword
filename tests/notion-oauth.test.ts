import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'
test('Notion authorization binds callback to provider and rotating credentials to the workspace', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'notion-'))
  let used = 0
  const api = service(dir, undefined, async (url, o) => {
    assert.equal(String(url), 'https://api.notion.com/v1/oauth/token')
    assert.equal(
      new Headers(o?.headers).get('authorization'),
      'Basic ' + Buffer.from('client:client-secret').toString('base64'),
    )
    const b = JSON.parse(String(o?.body))
    if (used) assert.equal(b.refresh_token, 'refresh-' + used)
    used++
    return Response.json({
      access_token: 'access-' + used,
      refresh_token: 'refresh-' + used,
      workspace_id: 'workspace',
    })
  })
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (url: string, payload: object, cookie = '') =>
    api.inject({ method: 'POST', url, payload, headers: { cookie } })
  const login = await post('/admin/login', {
      token: readFileSync(join(dir, 'operator.token'), 'utf8'),
    }),
    cookie = String(login.headers['set-cookie']).split(';')[0]
  const a = await post(
      '/admin/oauth/notion',
      { label: 'Editorial', client_id: 'client', client_secret: 'client-secret' },
      cookie,
    ),
    state = new URL(a.json().url).searchParams.get('state')
  const cb = '/callback?code=example&state=' + state
  assert.equal(
    (await api.inject({ url: '/oauth/google' + cb, headers: { cookie } })).statusCode,
    400,
  )
  assert.equal(
    (await api.inject({ url: '/oauth/notion' + cb, headers: { cookie } })).statusCode,
    302,
  )
  assert.equal(
    (await api.inject({ url: '/oauth/notion' + cb, headers: { cookie } })).statusCode,
    400,
  )
  const w = (await api.inject({ url: '/admin/workspace', headers: { cookie } })).json()
  assert.equal(w.connections[0].identity, 'workspace')
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await post('/admin/connections/' + w.connections[0].id + '/oauth-refresh', {}, cookie))
        .statusCode,
      200,
    )
  assert.equal(used, 3)
})
