import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'
test('identity-only app requires activation, same-session consent and a single PKCE exchange', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-delegate-')),
    origin = 'http://localhost:3000',
    api = service(dir, origin)
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    api.inject({ method: 'POST', url, payload, headers })
  const auth = await post('/admin/login', {
      token: readFileSync(join(dir, 'operator.token'), 'utf8'),
    }),
    h = { cookie: String(auth.headers['set-cookie']).split(';')[0] }
  const callback = 'https://app.example.invalid/callback',
    app = (
      await post(
        '/admin/apps',
        { label: 'Example', callback, audience: 'app.example.invalid', days: 1 },
        h,
      )
    ).json().id
  const verifier = 'v'.repeat(43),
    q = new URLSearchParams({
      application_id: app,
      redirect_uri: callback,
      state: 's'.repeat(43),
      code_challenge_method: 'S256',
      classes: '',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    })
  const begin = () => api.inject({ url: '/delegate?' + q })
  assert.equal((await begin()).statusCode, 403)
  await post('/admin/apps/' + app, { active: true }, h)
  const jump = new URL(String((await begin()).headers.location)),
    page = await api.inject({ url: jump.pathname + jump.search, headers: h })
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1],
    attempt = jump.searchParams.get('attempt')
  const confirmed = await post('/delegate/confirm', { csrf, attempt }, { ...h, origin })
  const location = new URL(String(confirmed.headers.location))
  assert.equal(location.origin, 'https://app.example.invalid')
  assert.equal(location.searchParams.get('state'), 's'.repeat(43))
  const body = {
    grant_type: 'authorization_code',
    application_id: app,
    redirect_uri: callback,
    code: location.searchParams.get('code'),
    code_verifier: verifier,
  }
  assert.equal(
    (await post('/delegate/exchange', { ...body, code_verifier: 'z'.repeat(43) })).statusCode,
    401,
  )
  const answer = (await post('/delegate/exchange', body)).json(),
    pieces = answer.delegation.split('.')
  const key = (await api.inject({ url: '/.well-known/zeoconnect-delegation-keys.json' })).json()
    .keys[0]
  assert.equal(
    verify(
      null,
      Buffer.from(pieces.slice(0, 2).join('.')),
      createPublicKey({ key, format: 'jwk' }),
      Buffer.from(pieces[2], 'base64url'),
    ),
    true,
  )
  assert.deepEqual(answer.principal.classes, [])
  assert.equal(answer.refresh_credential, undefined)
  assert.equal((await post('/delegate/exchange', body)).statusCode, 401)
})
