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
