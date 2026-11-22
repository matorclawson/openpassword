import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verifyLoopsWebhook, verifyTwilioWebhook } from '../packages/connectors/webhooks.ts'
test('Loops validates original bytes, timestamp tolerance and signing key', () => {
  const body = Buffer.from('{"ok": true}'),
    key = Buffer.from('example-signing-key'),
    t = '1700000000'
  const headers = {
    id: 'msg_test',
    timestamp: t,
    signature:
      'v1,' +
      createHmac('sha256', key)
        .update('msg_test.' + t + '.')
        .update(body)
        .digest('base64'),
  }
  assert.equal(
    verifyLoopsWebhook(body, headers, [key.toString('base64')], Number(t)).timestamp,
    Number(t),
  )
  assert.throws(() => verifyLoopsWebhook(body, headers, [key.toString('base64')], Number(t) + 301))
  assert.throws(() =>
    verifyLoopsWebhook(Buffer.from('{}'), headers, [key.toString('base64')], Number(t)),
  )
})
test('Twilio binds signature to URL and form fields', () => {
  const url = 'https://example.invalid/callback',
    form = new URLSearchParams({ Body: 'Hello', From: 'example' }),
    secret = 'example'
  const sig = createHmac('sha1', secret)
    .update(url + 'BodyHelloFromexample')
    .digest('base64')
  assert.equal(verifyTwilioWebhook(url, form, sig, secret), true)
  form.set('Body', 'Changed')
  assert.equal(verifyTwilioWebhook(url, form, sig, secret), false)
})
test('signed Loops deliveries survive restart, deduplicate and disappear from intake on revocation', async (t) => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path'),
    { service } = await import('../server/service.ts')
  const dir = mkdtempSync(join(tmpdir(), 'op-inbound-'))
  let api = service(dir)
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const token = readFileSync(join(dir, 'operator.token'), 'utf8')
  const login = async () => ({
    cookie: String(
      (await api.inject({ method: 'POST', url: '/admin/login', payload: { token } })).headers[
        'set-cookie'
      ],
    ).split(';')[0],
  })
  const h = await login()
  const conn = (
    await api.inject({
      method: 'POST',
      url: '/admin/connections',
      headers: h,
      payload: { provider: 'loops', label: 'Test', external_identity: 'Team', secret: 'example' },
    })
  ).json()
  const key = Buffer.from('test signing key'),
    site = (
      await api.inject({
        method: 'POST',
        url: '/admin/webhooks',
        headers: h,
        payload: { connection_id: conn.connection_id, secret: key.toString('base64') },
      })
    ).json()
  const timestamp = String(Math.floor(Date.now() / 1000)),
    body = '{"type":"fixture"}'
  const signature =
    'v1,' +
    createHmac('sha256', key)
      .update('delivery.' + timestamp + '.' + body)
      .digest('base64')
  const deliver = (payload = body) =>
    api.inject({
      method: 'POST',
      url: '/hooks/' + site.id,
      payload,
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'delivery',
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
      },
    })
  assert.equal((await deliver()).statusCode, 204)
  await api.close()
  api = service(dir)
  assert.equal((await deliver()).statusCode, 204)
  assert.equal((await deliver('{}')).statusCode, 403)
  const events = (
    await api.inject({ url: '/admin/webhooks/' + site.id + '/events', headers: h })
  ).json()
  assert.equal(events.length, 1)
  assert.deepEqual(events[0].payload, { type: 'fixture' })
  assert.equal(
    (await api.inject({ url: '/admin/webhooks/' + site.id, method: 'DELETE', headers: h }))
      .statusCode,
    204,
  )
  assert.equal((await deliver()).statusCode, 404)
})
