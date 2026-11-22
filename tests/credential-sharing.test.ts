import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'

test('organization, personal ownership, named shares and downstream revocation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-sharing-')),
    api = service(dir)
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (url: string, payload: object, cookie = '') =>
    api.inject({ method: 'POST', url, payload, headers: { cookie } })
  const login = async (token: string) =>
    String((await post('/admin/login', { token })).headers['set-cookie']).split(';')[0]
  const admin = await login(readFileSync(join(dir, 'operator.token'), 'utf8'))
  async function member(label: string, role: string) {
    const m = (await post('/admin/members', { label, role }, admin)).json()
    return { id: m.member_id, cookie: await login(m.token) }
  }
  const joe = await member('Joe', 'viewer'),
    jane = await member('Jane', 'editor'),
    other = await member('Other', 'editor')
  const create = (cookie: string, ownership: string, label: string) =>
    post(
      '/admin/connections',
      {
        ownership,
        label,
        provider: 'x',
        external_identity: 'private-account',
        secret: 'hidden-key',
      },
      cookie,
    )
  const org = (await create(admin, 'organization', 'Team account')).json().connection_id
  assert.equal((await create(joe.cookie, 'organization', 'Invalid')).statusCode, 403)
  const c = (await create(joe.cookie, 'personal', 'My account')).json().connection_id
  assert.ok(c)
  const list = async (cookie: string) =>
    (await api.inject({ url: '/admin/workspace', headers: { cookie } })).json().connections
  assert.deepEqual(
    (await list(jane.cookie)).map((x: { id: string }) => x.id),
    [org],
  )
  const settings = '/admin/connections/' + c + '/sharing'
  const share = (visibility: string, recipients: string[]) =>
    post(settings, { label: 'Joe account', visibility, recipients }, joe.cookie)
  assert.equal((await share('specific', [jane.id])).statusCode, 200)
  assert.equal((await list(jane.cookie)).find((x: { id: string }) => x.id === c).identity, '')
  assert.equal((await list(other.cookie)).length, 1)
  for (const actor of [admin, jane.cookie]) {
    assert.equal(
      (await post('/admin/connections/' + c + '/rotate', { secret: 'replacement' }, actor))
        .statusCode,
      403,
    )
    assert.equal(
      (await post(settings, { label: 'stolen', visibility: 'organization', recipients: [] }, actor))
        .statusCode,
      403,
    )
  }
  const issue = (cookie: string, id: string) =>
    post(
      '/admin/grants',
      { label: 'Agent', hours: 1, connection_id: id, operations: ['x.publish'] },
      cookie,
    )
  assert.equal((await issue(other.cookie, c)).statusCode, 404)
  const device = (await issue(jane.cookie, c)).json(),
    ownDevice = (await issue(joe.cookie, c)).json()
  const capabilities = (access: string) =>
    api.inject({
      url: '/v1/capabilities',
      headers: { authorization: 'Bearer ' + access, 'zeoconnect-protocol-version': '1' },
    })
  const shared = await capabilities(device.access_token)
  assert.equal(shared.statusCode, 200)
  assert.equal(shared.json().external_identity, c)
  assert.ok(!shared.body.includes('private-account'))
  assert.equal((await share('private', [])).statusCode, 200)
  assert.equal((await capabilities(device.access_token)).statusCode, 401)
  assert.equal((await capabilities(ownDevice.access_token)).statusCode, 200)
  assert.equal((await share('organization', [])).statusCode, 200)
  assert.equal((await list(other.cookie)).length, 2)
  assert.equal((await capabilities(device.access_token)).statusCode, 401)
  assert.equal(
    (await post('/admin/connections/' + c + '/rotate', { secret: 'replacement' }, joe.cookie))
      .statusCode,
    200,
  )
})
