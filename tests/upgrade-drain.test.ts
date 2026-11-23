import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { service } from '../server/service.ts'

test('drain rejects new model calls and lets one accepted call settle exactly once', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-drain-'))
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let calls = 0
  const api = service(dir, undefined, async () => {
    calls++
    entered.resolve()
    await resume.promise
    return Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } })
  })
  t.after(async () => {
    resume.resolve()
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const origin = await api.listen({ host: '127.0.0.1', port: 0 })
  const login = await api.inject({
    method: 'POST',
    url: '/admin/login',
    payload: { token: readFileSync(join(dir, 'operator.token'), 'utf8') },
  })
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  const post = async (url: string, payload: object) =>
    (await api.inject({ method: 'POST', url, payload, headers: { cookie } })).json()
  const c = await post('/admin/connections', {
    provider: 'openai',
    label: 'Test',
    external_identity: 'example',
    secret: 'fixture',
  })
  const g = await post('/admin/grants', {
    label: 'CLI',
    connection_id: c.connection_id,
    operations: ['openai.chat'],
    hours: 1,
    model_lease: { model: 'test', max_tokens: 10, calls: 2 },
  })
  const send = () =>
    fetch(origin + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + g.access_token },
      body: JSON.stringify({
        model: 'test',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'test' }],
      }),
    })
  const running = send()
  await entered.promise
  try {
    api.getDecorator<() => void>('beginDrain')()
    assert.equal((await send()).status, 503)
    assert.equal((await (await fetch(origin + '/health')).json()).in_flight, 1)
  } finally {
    resume.resolve()
  }
  const response = await running
  assert.equal(response.status, 200)
  assert.equal((await response.json()).usage.completion_tokens, 2)
  assert.equal(calls, 1)
  assert.equal((await (await fetch(origin + '/health')).json()).in_flight, 0)
})

test('drain waits for a model call that outlives its client until it settles', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-drain-'))
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const api = service(dir, undefined, async () => {
    entered.resolve()
    await resume.promise
    return Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } })
  })
  t.after(async () => {
    resume.resolve()
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const origin = await api.listen({ host: '127.0.0.1', port: 0 })
  const login = await api.inject({
    method: 'POST',
    url: '/admin/login',
    payload: { token: readFileSync(join(dir, 'operator.token'), 'utf8') },
  })
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  const post = async (url: string, payload: object) =>
    (await api.inject({ method: 'POST', url, payload, headers: { cookie } })).json()
  const c = await post('/admin/connections', {
    provider: 'openai',
    label: 'Test',
    external_identity: 'example',
    secret: 'fixture',
  })
  const g = await post('/admin/grants', {
    label: 'CLI',
    connection_id: c.connection_id,
    operations: ['openai.chat'],
    hours: 1,
    model_lease: { model: 'test', max_tokens: 10, calls: 2 },
  })
  const client = new AbortController()
  const running = fetch(origin + '/v1/chat/completions', {
    method: 'POST',
    signal: client.signal,
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + g.access_token },
    body: JSON.stringify({ model: 'test', max_tokens: 5, messages: [{ role: 'user', content: 'test' }] }),
  }).catch(() => undefined)
  await entered.promise
  api.getDecorator<() => void>('beginDrain')()
  client.abort()
  await running
  // The socket is gone but the upstream call has not returned: the drain must not report zero.
  await new Promise((done) => setTimeout(done, 100))
  assert.equal((await (await fetch(origin + '/health')).json()).in_flight, 1)
  resume.resolve()
  let left = 1
  for (let i = 0; i < 50 && left !== 0; i++) {
    await new Promise((done) => setTimeout(done, 50))
    left = (await (await fetch(origin + '/health')).json()).in_flight
  }
  assert.equal(left, 0)
})
