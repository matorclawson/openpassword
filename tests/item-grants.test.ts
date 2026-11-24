import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { service } from '../server/service.ts'
test('linked vault sources authorize provider operations, enforce workspace and role, and detach on rotation', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'source-access-'))
  let bearer = ''
  const api = service(home, undefined, async (_url, init) => {
    bearer = new Headers(init?.headers).get('authorization') || ''
    return Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })
  })
  t.after(async () => {
    await api.close()
    rmSync(home, { recursive: true, force: true })
  })
  const call = (url: string, payload: object, cookie = '') =>
    api.inject({ method: 'POST', url, payload, headers: { cookie } })
  const login = async (token: string) =>
    String((await call('/admin/login', { token })).headers['set-cookie']).split(';')[0]
  const admin = await login(readFileSync(join(home, 'operator.token'), 'utf8'))
  const item = (
    await call(
      '/admin/items',
      { title: 'Studio key', username: 'team', value: 'fixture-key' },
      admin,
    )
  ).json()
  const body = {
    label: 'Studio OpenAI',
    external_identity: 'studio',
    provider: 'openai',
    vault_item_id: item.id,
  }
  const c = (await call('/admin/connections', body, admin)).json().connection_id
  const g = (
    await call(
      '/admin/grants',
      {
        label: 'Codex',
        connection_id: c,
        hours: 168,
        operations: ['openai.chat'],
        model_lease: { model: 'demo', max_tokens: 8, calls: 3 },
      },
      admin,
    )
  ).json()
  const chat = () =>
    api.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'demo', max_tokens: 2, messages: [{ role: 'user', content: 'hi' }] },
      headers: {
        authorization: 'Bearer ' + g.access_token,
        'idempotency-key': crypto.randomUUID(),
      },
    })
  assert.equal((await chat()).statusCode, 200)
  assert.equal(bearer, 'Bearer fixture-key')
  const ws = async (cookie: string) =>
    (await api.inject({ url: '/admin/workspace', headers: { cookie } })).json()
  const state = await ws(admin)
  assert.deepEqual(state.connections[0].vault_item, { id: item.id, title: 'Studio key' })
  assert.ok(!JSON.stringify(state).includes('fixture-key'))
  assert.equal(state.grants[0].connection_id, c)
  assert.equal(state.grants[0].model, 'demo')
  const del = (url: string) => api.inject({ method: 'DELETE', url, headers: { cookie: admin } })
  assert.equal((await del('/admin/items/' + item.id)).statusCode, 409)
  const viewer = await login(
    (await call('/admin/members', { label: 'Viewer', role: 'viewer' }, admin)).json().token,
  )
  assert.equal(
    (await call('/admin/connections', { ...body, ownership: 'personal' }, viewer)).statusCode,
    403,
  )
  assert.equal((await ws(viewer)).grants.length, 0)
  assert.equal(
    (await call('/admin/connections/' + c + '/rotate', { secret: 'replacement' }, admin))
      .statusCode,
    200,
  )
  assert.equal((await ws(admin)).connections[0].vault_item, null)
  assert.equal((await chat()).statusCode, 200)
  assert.equal(bearer, 'Bearer replacement')
  assert.equal(
    (await call('/admin/connections/' + c + '/rotate', { vault_item_id: item.id }, admin))
      .statusCode,
    200,
  )
  assert.equal((await chat()).statusCode, 200)
  assert.equal(bearer, 'Bearer fixture-key')
  assert.equal((await del('/admin/grants/' + g.device_id)).statusCode, 200)
  assert.equal((await chat()).statusCode, 401)
  const other = (await call('/admin/workspaces', { label: 'Other' }, admin)).json()
  await call('/admin/switch', other, admin)
  assert.equal((await call('/admin/connections', body, admin)).statusCode, 404)
})
