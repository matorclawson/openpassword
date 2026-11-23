// Run with node --import tsx scripts/gateway-load.ts from the repository root.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { service } from '../server/service.ts'

const dir = mkdtempSync(join(tmpdir(), 'openpassword-load-'))
const total = 3000
const concurrency = 40
const interval = process.argv.includes('--minute') ? 60000 / total : 0
let sent = 0
const api = service(dir, undefined, async () => {
  sent++
  return Response.json({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } })
})
try {
  const origin = await api.listen({ host: '127.0.0.1', port: 0 })
  const login = await api.inject({
    method: 'POST',
    url: '/admin/login',
    payload: { token: readFileSync(join(dir, 'operator.token'), 'utf8') },
  })
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  async function create(url: string, payload: object) {
    const r = await api.inject({ method: 'POST', url, payload, headers: { cookie } })
    assert.equal(r.statusCode, 200, r.body)
    return r.json()
  }
  const c = await create('/admin/connections', {
    provider: 'openai',
    label: 'Benchmark',
    external_identity: 'fixture',
    secret: 'fixture',
  })
  const grant = await create('/admin/grants', {
    label: 'benchmark',
    connection_id: c.connection_id,
    operations: ['openai.chat'],
    hours: 1,
    model_lease: { model: 'test', max_tokens: 10, calls: total },
  })
  const headers = {
    authorization: 'Bearer ' + grant.access_token,
    'content-type': 'application/json',
    'OpenPassword-Protocol-Version': '1',
  }
  const payload = JSON.stringify({
    model: 'test',
    max_tokens: 5,
    messages: [{ role: 'user', content: 'fixture' }],
  })
  let seen = 0
  const observer = (async () => {
    let cursor = 0
    while (seen < 2 * total) {
      const r = await fetch(origin + '/v1/activity?after=' + cursor, {
        headers,
        signal: AbortSignal.timeout(30000),
      })
      assert.equal(r.status, 200)
      const page = await r.json()
      assert.ok(page.events.length, 'timed out waiting for activity')
      for (const e of page.events) {
        assert.ok(e.id > cursor)
        cursor = e.id
        seen++
      }
    }
  })()
  let next = 0
  const times: number[] = []
  const start = performance.now()
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < total) {
      const id = next++
      const scheduled = start + id * interval
      if (scheduled > performance.now())
        await new Promise((done) => setTimeout(done, scheduled - performance.now()))
      const t = performance.now()
      const r = await fetch(origin + '/v1/chat/completions', {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'load-' + id },
        body: payload,
      })
      assert.equal(r.status, 200, await r.text())
      times.push(performance.now() - t)
    }
  })
  await Promise.all([...workers, observer])
  const elapsed = performance.now() - start
  times.sort((a, b) => a - b)
  const db = new DatabaseSync(join(dir, 'vault.sqlite'), { readOnly: true })
  try {
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS n FROM consumption_events WHERE seat=? AND status=200')
        .get(grant.device_id)?.n,
      total,
    )
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM runs WHERE actor=?').get(grant.device_id)?.n,
      total,
    )
  } finally {
    db.close()
  }
  assert.equal(sent, total)
  assert.equal(seen, total * 2)
  console.log(
    JSON.stringify({
      total,
      concurrency,
      events: seen,
      elapsed_ms: Math.round(elapsed),
      rpm: Math.round((total * 60000) / elapsed),
      p95_ms: Math.round(times[Math.floor(times.length * 0.95)]),
    }),
  )
} finally {
  await api.close()
  rmSync(dir, { recursive: true, force: true })
}
