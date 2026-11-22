import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'
for (const metered of [false, true])
  test(
    (metered ? 'metered ' : '') +
      'streaming model lease enforces exact model, token ceiling, call count and unique claim',
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'op-model-'))
      let sends = 0
      const frame =
        (metered ? 'data: {"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n' : '') +
        'data: {"choices":[]}\n\ndata: [DONE]\n\n'
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
          model_lease: {
            model: 'example',
            max_tokens: 10,
            calls: 1,
            ...(metered
              ? {
                  tariff: {
                    source: 'https://example.invalid/pricing',
                    as_of: '2026-11-22',
                    budget_micro_usd: 1000,
                    input: 1000000,
                    output: 2000000,
                  },
                }
              : {}),
          },
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
      if (metered) {
        const w = (await api.inject({ url: '/admin/workspace', headers: { cookie } })).json()
        assert.equal(w.billing[0].spent, 8)
        assert.equal(w.billing[0].held, 0)
        assert.equal(w.billing[0].available, 992)
      }
      assert.equal(sends, 1)
    },
  )
test('model requests carry tool schemas and correlated tool results', async () => {
  const { chat } = await import('../server/models.ts')
  const body = {
    model: 'example',
    max_tokens: 12,
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call1', content: 'fixture' },
    ],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'lookup' } },
  }
  assert.deepEqual(chat.parse(body), { ...body, stream: false })
  assert.equal(
    chat.safeParse({ ...body, tool_choice: { type: 'function', function: { name: 'other' } } })
      .success,
    false,
  )
})
