import test from 'node:test'
import assert from 'node:assert/strict'
import { intakeKeys } from '../server/intake.ts'
import { sealInput } from '../app/intake.ts'
test('browser credential envelope binds its ticket and conceals plaintext', async () => {
  const keys = intakeKeys(),
    sealed = await sealInput('example-secret', {
      ticket: 'example-ticket',
      publicKey: keys.publicKey as JsonWebKey,
    })
  assert.equal(keys.unseal(sealed), 'example-secret')
  assert.ok(!JSON.stringify(sealed).includes('example-secret'))
  assert.throws(() => keys.unseal({ ...sealed, ticket: 'other-ticket' }))
})
