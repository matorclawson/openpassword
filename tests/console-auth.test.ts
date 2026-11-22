import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { service } from '../server/service.ts'

for (const provider of ['google', 'github'])
  test(provider + ' administrator setup, linking and sign-in', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'op-auth-')),
      origin = 'https://vault.example.com'
    let different = false
    const api = service(dir, origin, async (url) => {
      if (String(url).includes('token')) return Response.json({ access_token: 'fixture' })
      return Response.json(
        provider === 'github' ? { id: different ? 2 : 1 } : { sub: different ? 'other' : 'first' },
      )
    })
    t.after(async () => {
      await api.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const post = (url: string, payload: Record<string, unknown>, cookie = '') =>
      api.inject({ method: 'POST', url, payload, headers: { cookie, origin } })
    const creds = { username: 'operator', password: 'fixture-password-42' }
    const token = readFileSync(join(dir, 'operator.token'), 'utf8')
    assert.equal((await post('/auth/setup', { ...creds, token: 'wrong' })).statusCode, 403)
    const race = await Promise.all([1, 2].map(() => post('/auth/setup', { ...creds, token })))
    assert.deepEqual(race.map((r) => r.statusCode).sort(), [200, 409])
    const owner = String(race.find((r) => r.statusCode === 200)!.headers['set-cookie']).split(
      ';',
    )[0]
    assert.equal((await post('/admin/login', { token })).statusCode, 401)
    assert.equal((await post('/auth/password', { ...creds, password: 'wrong' })).statusCode, 401)
    assert.equal((await post('/auth/password', creds)).statusCode, 200)
    const path = '/admin/authentication/' + provider
    assert.equal((await post(path, { client: 'id', secret: 'fixture-secret' })).statusCode, 401)
    assert.equal(
      (await post(path, { client: 'id', secret: 'fixture-secret' }, owner)).statusCode,
      200,
    )
    const settings = await api.inject({ url: '/admin/authentication', headers: { cookie: owner } })
    assert.ok(!settings.body.includes('fixture-secret'))
    assert.ok(settings.body.includes(origin + '/api/auth/' + provider + '/callback'))
    async function flow(link: boolean) {
      const start = await post('/auth/' + provider + '/start', { link }, link ? owner : '')
      assert.equal(start.statusCode, 200)
      const url = new URL(start.json().url)
      assert.equal(
        url.searchParams.get('redirect_uri'),
        origin + '/api/auth/' + provider + '/callback',
      )
      const callback =
        '/auth/' + provider + '/callback?code=fixture&state=' + url.searchParams.get('state')
      const cookie = String(start.headers['set-cookie']).split(';')[0] + (link ? '; ' + owner : '')
      assert.equal((await api.inject(callback)).headers.location, '/?signin=failed')
      const result = await api.inject({ url: callback, headers: { cookie } })
      assert.equal(
        (await api.inject({ url: callback, headers: { cookie } })).headers.location,
        '/?signin=failed',
      )
      return result
    }
    assert.equal((await flow(true)).headers.location, '/?signin=linked')
    const success = await flow(false)
    assert.equal(success.headers.location, '/')
    assert.match(String(success.headers['set-cookie']), /op_session=/)
    different = true
    const denied = await flow(false)
    assert.equal(denied.headers.location, '/?signin=failed')
    assert.doesNotMatch(String(denied.headers['set-cookie']), /op_session=/)
    assert.equal(
      (await api.inject({ method: 'DELETE', url: path, headers: { cookie: owner } })).statusCode,
      200,
    )
    assert.deepEqual((await api.inject('/auth/status')).json().providers, [])
  })

test('Apple first admin can add a password and a viewer can manage an independent login', async (t) => {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose')
  const keys = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(keys.publicKey)), alg: 'RS256', kid: 'test' }
  const dir = mkdtempSync(join(tmpdir(), 'op-apple-')),
    origin = 'https://console.example.com'
  let nonce = ''
  const api = service(dir, origin, async (url) => {
    if (String(url).endsWith('/keys')) return Response.json({ keys: [jwk] })
    const jwt = await new SignJWT({ nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject('apple-user')
      .setIssuer('https://appleid.apple.com')
      .setAudience('services.id')
      .setExpirationTime('5m')
      .sign(keys.privateKey)
    return Response.json({ id_token: jwt })
  })
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (url: string, payload: Record<string, unknown>, cookie = '') =>
    api.inject({ method: 'POST', url, payload, headers: { cookie, origin } })
  const start = await post('/auth/apple/start', {
    link: false,
    setup: {
      token: readFileSync(join(dir, 'operator.token'), 'utf8'),
      client: 'services.id',
      secret: 'fixture',
    },
  })
  const url = new URL(start.json().url)
  nonce = url.searchParams.get('nonce')!
  const cb = await api.inject({
    url: '/auth/apple/callback?code=sample&state=' + url.searchParams.get('state'),
    headers: { cookie: String(start.headers['set-cookie']).split(';')[0] },
  })
  const owner = String(cb.headers['set-cookie']).match(/op_session=[^;]+/)?.[0]
  assert.ok(owner)
  assert.equal(
    (await api.inject({ method: 'DELETE', url: '/profile/apple', headers: { cookie: owner } }))
      .statusCode,
    409,
  )
  assert.equal(
    (
      await post(
        '/profile/password',
        { username: 'admin', password: 'another-long-password' },
        owner,
      )
    ).statusCode,
    200,
  )
  const invite = await post('/admin/members', { label: 'Reader', role: 'viewer' }, owner)
  const viewer = String(
    (await post('/admin/login', { token: invite.json().token })).headers['set-cookie'],
  ).split(';')[0]
  const creds = { username: 'reader', password: 'a-viewer-password' }
  assert.equal((await post('/profile/password', creds, viewer)).statusCode, 200)
  const cookie = String((await post('/auth/password', creds)).headers['set-cookie']).split(';')[0]
  assert.equal((await api.inject({ url: '/profile', headers: { cookie } })).json().role, 'viewer')
  assert.equal(
    (await post('/admin/authentication/github', { client: 'x', secret: 'y' }, cookie)).statusCode,
    403,
  )
})

test('Google-first administrator adds a password and GitHub to the same profile', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-multi-')),
    origin = 'https://console.example.com'
  const api = service(dir, origin, async (url) =>
    Response.json(
      String(url).includes('token')
        ? { access_token: 'example' }
        : String(url).includes('github')
          ? { id: 42 }
          : { sub: 'google-1' },
    ),
  )
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (url: string, payload: Record<string, unknown>, cookie = '') =>
    api.inject({ method: 'POST', url, payload, headers: { cookie, origin } })
  async function authorize(p: string, params: Record<string, unknown>, session = '') {
    const start = await post('/auth/' + p + '/start', params, session)
    const state = new URL(start.json().url).searchParams.get('state')
    const cookie = [String(start.headers['set-cookie']).split(';')[0], session]
      .filter(Boolean)
      .join('; ')
    return api.inject({
      url: '/auth/' + p + '/callback?code=fixture&state=' + state,
      headers: { cookie },
    })
  }
  const init = await authorize('google', {
    link: false,
    setup: {
      token: readFileSync(join(dir, 'operator.token'), 'utf8'),
      client: 'id',
      secret: 'secret',
    },
  })
  const owner = String(init.headers['set-cookie']).match(/op_session=[^;]+/)![0]
  const credentials = { username: 'admin', password: 'test-google-first' }
  assert.equal((await post('/profile/password', credentials, owner)).statusCode, 200)
  assert.equal(
    (
      await post(
        '/admin/authentication/github',
        { client: 'github-id', secret: 'github-secret' },
        owner,
      )
    ).statusCode,
    200,
  )
  assert.equal(
    (await authorize('github', { link: true }, owner)).headers.location,
    '/?signin=linked',
  )
  for (const result of [
    await authorize('google', { link: false }),
    await authorize('github', { link: false }),
    await post('/auth/password', credentials),
  ]) {
    const cookie = String(result.headers['set-cookie']).match(/op_session=[^;]+/)![0]
    const profile = (await api.inject({ url: '/profile', headers: { cookie } })).json()
    assert.equal(profile.username, 'admin')
    assert.equal(profile.role, 'owner')
    assert.equal(profile.providers.filter((p: { linked: number }) => p.linked).length, 2)
  }
})
