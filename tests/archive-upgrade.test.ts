import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activate } from '../deploy/upgrade.ts'
const old = { version: '0.2.0', units: ['host-node-broker', 'host-node-web'] }
const next = { version: '0.3.0', units: ['bundled-node-broker', 'bundled-node-web'] }
for (const failure of ['none', 'drain', 'readiness', 'restore'])
  test('archive activation: ' + failure, async () => {
    let current = old,
      pending: typeof old | null = null,
      previous: typeof old | null = null
    const result = activate(old, next, {
      save: (s) => {
        pending = s as typeof old
      },
      drain: async () => {
        if (failure === 'drain') throw Error('drain')
      },
      switchTo: async (s) => {
        assert.deepEqual(pending, old)
        current = s as typeof old
        if (s === next && ['readiness', 'restore'].includes(failure)) throw Error('bad candidate')
        if (s === old && failure === 'restore') throw Error('failed restore')
      },
      finish: (s) => {
        previous = s as typeof old
      },
      clear: () => {
        pending = null
      },
    })
    if (failure === 'none') {
      await result
      assert.deepEqual(current, next)
      assert.deepEqual(previous, old)
    } else {
      await assert.rejects(result)
      assert.deepEqual(current, old)
    }
    assert.deepEqual(pending, failure === 'restore' ? old : null)
  })
