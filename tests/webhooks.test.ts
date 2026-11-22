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
