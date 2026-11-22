import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { keymaster } from '../server/keymaster.ts'
test('GitHub admission recognizes literal operation paths, capability, stops and duplicate JSON keys', async (t) => {
  const api = Fastify()
  let paused = false
  keymaster(
    api,
    () => ({ tenant: 'test' }),
    () => paused,
  )
  t.after(() => api.close())
  const payload = {
    connection_id: 'role_editor',
    operation_id: 'github.ref.read',
    arguments: { repository: 'example/project', ref: 'refs/heads/main' },
    idempotency_key: 'i'.repeat(32),
    door_request_id: 'request-01',
    on_behalf_of: {
      principal_id: 'prn_user',
      incarnation: 1,
      authenticated_as: {
        host_id: 'host_test',
        host_incarnation: 1,
        os_account: 'example',
        account_incarnation: 1,
      },
    },
  }
  const post = (cap: string, p = JSON.stringify(payload)) =>
    api.inject({
      method: 'POST',
      url: '/v1/operations/github.ref.read:invoke',
      headers: { 'content-type': 'application/json', 'openpassword-capabilities': cap },
      payload: p,
    })
  assert.equal((await post('')).statusCode, 422)
  assert.deepEqual((await post('github-keymaster')).json(), {
    code: 'unavailable',
    reason: 'not_enrolled',
  })
  assert.equal(
    (
      await post(
        'github-keymaster',
        JSON.stringify(payload).replace('"ref":', '"ref":"refs/heads/first","ref":'),
      )
    ).statusCode,
    422,
  )
  paused = true
  assert.equal((await post('github-keymaster')).statusCode, 403)
})
