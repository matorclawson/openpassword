import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { billing, charge, tariff } from '../server/billing.ts'
test('five-component model usage and an ambiguous reservation never settle at a guessed price', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const t = tariff.parse({
      budget_micro_usd: 700,
      input: 1000000,
      output: 2000000,
      cache_read: 3000000,
      reasoning: 4000000,
      source: 'https://example.invalid/prices',
      as_of: '2026-11-22',
      mapping: {
        prompt: 'in',
        completion: 'out',
        cache_read: 'cached',
        reasoning: 'reason',
        reasoning_in_completion: false,
      },
    })
    assert.equal(charge(t, { in: 3, out: 2, cached: 1, reason: 3 }), 21)
    assert.equal(charge(t, { in: 3, out: 2, reason: 3 }), null)
    const meter = billing(db)
    meter.configure('g', t)
    meter.claim('g', 'execution', { messages: [{ role: 'user' }], max_tokens: 5 }, 100)
    meter.finish('execution', null, false)
    assert.equal(db.prepare('select state from model_charges').get()?.state, 'held')
    assert.throws(
      () => meter.claim('g', 'second', { messages: [{ role: 'user' }], max_tokens: 50 }, 200),
      /budget/,
    )
  } finally {
    db.close()
  }
})
