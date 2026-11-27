import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'
test('separate model custodian holds the upstream key and independently limits the router', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-separate-custody-'))
  const custodian = 'https://custodian.example',
    upstreamKey = 'synthetic-provider-key'
  let calls = 0
  const back = service(join(dir, 'back'), custodian, async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + upstreamKey)
    calls++
    return new Response(
      JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    )
  })
  const prev = process.env.OPENPASSWORD_MODEL_CUSTODIAN_ORIGIN
  process.env.OPENPASSWORD_MODEL_CUSTODIAN_ORIGIN = custodian
  let observed = ''
  const front = service(join(dir, 'front'), 'https://router.example', async (url, init) => {
    assert.equal(String(url), custodian + '/v1/chat/completions')
    observed = new Headers(init?.headers).get('authorization') || ''
    const r = await back.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: observed },
      payload: JSON.parse(String(init?.body)),
    })
    return new Response(r.body, { status: r.statusCode })
  })
  if (prev === undefined) delete process.env.OPENPASSWORD_MODEL_CUSTODIAN_ORIGIN
  else process.env.OPENPASSWORD_MODEL_CUSTODIAN_ORIGIN = prev
  t.after(async () => {
    await front.close()
    await back.close()
    rmSync(dir, { recursive: true, force: true })
  })
  async function configure(
    api: typeof front,
    location: string,
    provider: string,
    secret: string,
    count: number,
  ) {
    const session = await api.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { token: readFileSync(join(dir, location, 'operator.token'), 'utf8') },
    })
    const cookie = String(session.headers['set-cookie']).split(';')[0]
    const post = (url: string, payload: object) =>
      api.inject({ method: 'POST', url, payload, headers: { cookie } })
    const c = await post('/admin/connections', {
      label: 'Fixture',
      external_identity: 'fixture',
      provider,
      secret,
    })
    assert.equal(c.statusCode, 200)
    const grant = await post('/admin/grants', {
      connection_id: c.json().connection_id,
      label: 'Limited',
      operations: [provider + '.chat'],
      hours: 1,
      model_lease: { model: 'example', max_tokens: 10, calls: count },
    })
    assert.equal(grant.statusCode, 200)
    return {
      token: grant.json().access_token as string,
      connection: c.json().connection_id as string,
    }
  }
  const { token: downstream, connection } = await configure(back, 'back', 'openai', upstreamKey, 1)
  const { token } = await configure(front, 'front', 'remote_gateway', downstream, 3)
  const direct = await back.inject({
    method: 'POST',
    url: '/v1/operations/openai.chat:invoke',
    headers: { authorization: 'Bearer ' + downstream, 'openpassword-protocol-version': '1' },
    payload: {
      idempotency_key: 'bypass',
      connection_id: connection,
      operation_id: 'openai.chat',
      arguments: {},
    },
  })
  assert.equal(direct.statusCode, 403)
  const use = () =>
    front.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ' + token },
      payload: { model: 'example', max_tokens: 5, messages: [{ role: 'user', content: 'test' }] },
    })
  assert.equal((await use()).statusCode, 200)
  assert.equal(observed, 'Bearer ' + downstream)
  assert.equal((await use()).statusCode, 502)
  assert.equal(calls, 1)
})
