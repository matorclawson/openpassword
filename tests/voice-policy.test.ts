import test from 'node:test'
import assert from 'node:assert/strict'
import { cloningDecision, isCloningOperation } from '../server/voice-policy.ts'

const approval = { approver: 'owner-1', role: 'owner', method: 'console', consent_ref: 'consent-2026-001', at: 1 }

test('cloning operations are recognized and speech operations are not', () => {
  for (const op of ['elevenlabs.voice.clone', 'x.voice.convert', 'x.voice.design', 'x.voice.clone.instant'])
    assert.equal(isCloningOperation(op), true, op)
  for (const op of ['elevenlabs.audio.speech', 'openai.chat', 'x.voice.list', 'voice.cloned.audio', ''])
    assert.equal(isCloningOperation(op), false, op)
})

test('a grant without cloning operations needs no approval', () => {
  assert.deepEqual(cloningDecision({ operations: ['x.audio.speech'], vendorConsent: false }), { ok: true, cloning: false })
})

test('cloning needs a human owner approval from the console, a consent reference and a vendor consent mechanism', () => {
  const ops = ['x.audio.speech', 'x.voice.clone']
  assert.deepEqual(cloningDecision({ operations: ops, approval, vendorConsent: true }), { ok: true, cloning: true })
  assert.equal(cloningDecision({ operations: ops, approval, vendorConsent: false }).ok, false)
  for (const bad of [
    null,
    undefined,
    { ...approval, role: 'editor' },
    { ...approval, method: 'api' },
    { ...approval, method: 'agent' },
    { ...approval, approver: '' },
    { ...approval, consent_ref: ' ' },
    { ...approval, at: Number.NaN },
  ]) {
    const d = cloningDecision({ operations: ops, approval: bad as never, vendorConsent: true })
    assert.equal(d.ok === false && d.code, 'cloning_approval_required')
  }
  const d = cloningDecision({ operations: ops, approval, vendorConsent: false })
  assert.equal(d.ok === false && d.code, 'cloning_vendor_unsupported')
})
