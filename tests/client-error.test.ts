import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenPassword } from '../packages/client/index.ts'

const headers = { 'openpassword-protocol-version': '1' }

test('a refused request reports the broker explanation as one short line', async (t) => {
  let body = '{"detail":"Expired pairing"}'
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 400, headers }))
  const client = new OpenPassword('http://localhost')
  const message = async (call: Promise<unknown>) => {
    const error = (await call.then(
      () => assert.fail('the request was accepted'),
      (e: unknown) => e,
    )) as Error & { status?: number }
    assert.equal(error.status, 400)
    return error.message
  }

  assert.equal(await message(client.redeem('code')), 'Broker returned 400: Expired pairing')
  assert.equal(
    await message(client.artifact('art_123e4567-e89b-12d3-a456-426614174000')),
    'Broker returned 400: Expired pairing',
  )

  // Terminal controls, direction overrides and line breaks never reach the caller.
  body = JSON.stringify({ detail: 'one\r\ntwo\u001b[2J‮three four' })
  assert.equal(await message(client.redeem('code')), 'Broker returned 400: one two [2J three four')

  body = JSON.stringify({ detail: 'x'.repeat(5000) })
  assert.equal(await message(client.redeem('code')), 'Broker returned 400: ' + 'x'.repeat(200))

  for (body of ['', 'not json', 'null', '{"detail":{"nested":true}}', '{"detail":" "}'])
    assert.equal(await message(client.redeem('code')), 'Broker returned 400', body)
})
