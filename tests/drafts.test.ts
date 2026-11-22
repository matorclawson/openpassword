import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'
test('standing draft limit is consumed once, exact replay works while paused', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-draft-'))
  let sends = 0
  const api = service(dir, undefined, async () => {
    sends++
    return Response.json({ id: 'id', status: 'Draft', emailMessageId: 'mail' })
  })
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    api.inject({ method: 'POST', url, payload, headers })
  const login = await post('/admin/login', {
    token: readFileSync(join(dir, 'operator.token'), 'utf8'),
  })
  const h = { cookie: String(login.headers['set-cookie']).split(';')[0] }
  const c = (
    await post(
      '/admin/connections',
      { provider: 'loops', label: 'Editorial', external_identity: 'example', secret: 'example' },
      h,
    )
  ).json().connection_id
  const op = 'loops.newsletter.create_campaign'
  const g = (
    await post(
      '/admin/grants',
      { connection_id: c, operations: [op], hours: 1, label: 'Writer', draft_limit: 1 },
      h,
    )
  ).json()
  const invoke = (key: string) =>
    post(
      '/v1/operations/' + op + ':invoke',
      {
        connection_id: c,
        arguments: { name: 'Draft one' },
        operation_id: op,
        idempotency_key: key,
      },
      { authorization: 'Bearer ' + g.access_token, 'zeoconnect-protocol-version': '1' },
    )
  assert.equal((await invoke('one')).json().status, 'confirmed')
  await post('/admin/dispatch', { paused: true }, h)
  assert.equal((await invoke('one')).json().receipt.replayed, true)
  assert.equal((await invoke('two')).statusCode, 423)
  await post('/admin/dispatch', { paused: false }, h)
  assert.equal((await invoke('two')).json().status, 'approval_required')
  assert.equal(sends, 1)
})
