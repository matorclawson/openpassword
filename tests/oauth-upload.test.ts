import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'
test('OAuth state is session bound and consumed once; approved upload session is scoped to its device', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-oauth-')),
    link = 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=sample'
  let puts = 0
  const api = service(
    dir,
    'http://localhost:3000',
    async (url, init) => {
      const u = new URL(String(url))
      if (u.host === 'oauth2.googleapis.com')
        return Response.json({
          access_token: 'example-youtube-token',
          refresh_token: 'example-refresh',
          expires_in: 3600,
        })
      if (u.host === 'openidconnect.googleapis.com')
        return Response.json({ email: 'person@example.com', email_verified: true })
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer example-youtube-token')
      if (init?.method === 'PUT') {
        puts++
        return Response.json({ id: 'example', status: { privacyStatus: 'private' } })
      }
      return new Response(null, { status: 200, headers: { location: link } })
    },
    true,
  )
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    api.inject({ method: 'POST', url, payload, headers })
  const login = async () => ({
    cookie: String(
      (await post('/admin/login', { token: readFileSync(join(dir, 'operator.token'), 'utf8') }))
        .headers['set-cookie'],
    ).split(';')[0],
  })
  const h = await login(),
    other = await login()
  const start = (
    await post(
      '/admin/oauth/google',
      {
        client_id: 'example-id',
        client_secret: 'example-client-secret',
        scope: 'https://www.googleapis.com/auth/youtube.upload',
        label: 'Example',
      },
      h,
    )
  ).json()
  const u = new URL(start.url)
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  const callback = '/oauth/google/callback?code=example&state=' + u.searchParams.get('state')
  assert.equal((await api.inject({ url: callback, headers: other })).statusCode, 400)
  assert.equal((await api.inject({ url: callback, headers: h })).statusCode, 302)
  assert.equal((await api.inject({ url: callback, headers: h })).statusCode, 400)
  const w = (await api.inject({ url: '/admin/workspace', headers: h })).json(),
    c = w.connections[0].id
  const op = 'youtube.video.upload_session.create',
    grant = { label: 'Video device', connection_id: c, operations: [op], hours: 1 }
  const bearer = (await post('/admin/grants', grant, h)).json().access_token,
    auth = { 'zeoconnect-protocol-version': '1', authorization: 'Bearer ' + bearer }
  const body = {
    connection_id: c,
    operation_id: op,
    arguments: {
      size_bytes: 3,
      content_sha256: '0'.repeat(64),
      mime_type: 'video/mp4',
      metadata: { title: 'Example' },
      status: { privacy: 'private' },
    },
    idempotency_key: 'upload1',
  }
  const invoke = '/v1/operations/' + op + ':invoke',
    a = (await post(invoke, body, auth)).json()
  await post('/admin/approvals/' + a.execution_id, { approve: true }, h)
  const result = (await post(invoke, body, auth)).json().result
  assert.equal(result.upload_url, link)
  assert.equal((await post(invoke, body, auth)).json().result.upload_url, null)
  const headers = {
    ...auth,
    'content-type': 'application/octet-stream',
    'x-zeo-connection': c,
    'x-zeo-content-range': 'bytes 0-2/3',
    'x-zeo-upload-link': link,
    'x-zeo-relay-seal': result.relay_seal,
  }
  const relay = (headers: Record<string, string>) =>
    api.inject({
      method: 'POST',
      url: '/v1/youtube/uploads:relay',
      payload: Buffer.from('abc'),
      headers,
    })
  assert.equal(
    (await relay({ ...headers, 'x-zeo-upload-link': 'https://example.invalid' })).statusCode,
    403,
  )
  assert.equal((await relay(headers)).json().status, 200)
  assert.equal(puts, 1)
})
