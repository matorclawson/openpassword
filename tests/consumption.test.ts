import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'

test('60 concurrent seat requests remain attributable after revocation and restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-consumption-'))
  let started = 0,
    release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const send = async () => {
    if (++started === 60) release()
    await barrier
    return Response.json({ usage: { prompt_tokens: 2, completion_tokens: 3 } })
  }
  let api = service(dir, undefined, send)
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (url: string, payload: object, headers: Record<string, string>) =>
    api.inject({ method: 'POST', url, payload, headers })
  const cookie = String(
    (await post('/admin/login', { token: readFileSync(join(dir, 'operator.token'), 'utf8') }, {}))
      .headers['set-cookie'],
  ).split(';')[0]
  const owner = { cookie }
  const c = (
    await post(
      '/admin/connections',
      {
        provider: 'openai',
        label: 'Shared AI',
        external_identity: 'fixture',
        secret: 'upstream-secret',
      },
      owner,
    )
  ).json()
  const grants: { access_token: string }[] = []
  for (let i = 0; i < 60; i++) {
    const r = await post(
      '/admin/grants',
      {
        connection_id: c.connection_id,
        label: 'seat-' + i,
        hours: 1,
        operations: ['openai.chat'],
        model_lease: {
          model: 'fixture',
          max_tokens: 16,
          calls: 2,
          tariff: {
            input: 1000000,
            output: 2000000,
            budget_micro_usd: 1000,
            as_of: '2026-11-22',
            source: 'https://example.invalid/pricing',
          },
        },
      },
      owner,
    )
    assert.equal(r.statusCode, 200)
    grants.push(r.json())
  }
  const execute = (g: (typeof grants)[number]) =>
    post(
      '/v1/chat/completions',
      { messages: [{ role: 'user', content: 'secret prompt' }], model: 'fixture', max_tokens: 8 },
      { authorization: 'Bearer ' + g.access_token, 'idempotency-key': 'same-per-seat' },
    )
  const clock = performance.now()
  const responses = await Promise.all(grants.map(execute))
  assert.ok(responses.every((r) => r.statusCode === 200))
  console.log(
    '60 concurrent mocked upstream calls completed in ' +
      Math.round(performance.now() - clock) +
      ' ms',
  )
  assert.equal((await execute(grants[0])).statusCode, 409)
  await api.inject({
    method: 'DELETE',
    url: '/admin/connections/' + c.connection_id,
    headers: owner,
  })
  await api.close()
  api = service(dir, undefined, send)
  const report = await api.inject({ url: '/admin/consumption?days=0', headers: owner })
  assert.equal(report.statusCode, 200)
  const { groups, events } = report.json()
  assert.equal(groups[0].requests, 60)
  assert.equal(groups[0].priced_micro_usd, 480)
  assert.equal(groups[0].input_tokens, 120)
  assert.equal(groups[0].output_tokens, 180)
  assert.equal(new Set(events.map((e: { seat: string }) => e.seat)).size, 60)
  assert.ok(!report.body.includes('secret prompt'))
  assert.ok(!report.body.includes('upstream-secret'))
})
