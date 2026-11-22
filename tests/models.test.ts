import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'
test('streaming model lease enforces exact model, token ceiling, call count and unique claim', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-model-'))
  let sends = 0
  const frame = 'data: {"choices":[]}\n\ndata: [DONE]\n\n'
  const api = service(dir, undefined, async () => {
    sends++
    return new Response(frame, { headers: { 'content-type': 'text/event-stream' } })
  })
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const login = await api.inject({
    method: 'POST',
    url: '/admin/login',
    payload: { token: readFileSync(join(dir, 'operator.token'), 'utf8') },
  })
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  const post = (url: string, payload: object, headers: Record<string, string> = { cookie }) =>
    api.inject({ method: 'POST', url, payload, headers })
  const c = (
    await post('/admin/connections', {
      provider: 'openai',
      label: 'Model account',
      external_identity: 'research',
      secret: 'test-token',
    })
  ).json()
  const g = (
    await post('/admin/grants', {
      label: 'App',
      connection_id: c.connection_id,
      operations: ['openai.chat'],
      hours: 1,
      model_lease: { model: 'example', max_tokens: 10, calls: 1 },
    })
  ).json()
  const h = { authorization: 'Bearer ' + g.access_token, 'idempotency-key': 'one' },
    url = '/v1/chat/completions'
  const body = {
    model: 'example',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'Hi' }],
    stream: true,
  }
  assert.equal((await post(url, { ...body, model: 'other' }, h)).statusCode, 403)
  assert.equal((await post(url, { ...body, max_tokens: 11 }, h)).statusCode, 403)
  assert.equal((await post(url, body, h)).body, frame)
  assert.equal((await post(url, body, h)).statusCode, 409)
  assert.equal((await post(url, body, { ...h, 'idempotency-key': 'two' })).statusCode, 403)
  assert.equal(sends, 1)
})
