import test from 'node:test'
import assert from 'node:assert/strict'
import { cloningDecision, isCloningOperation, type ClassifiedOperation } from '../server/voice-policy.ts'

const cls = (names: string[], cloning = false): ClassifiedOperation[] => names.map((name) => ({ name, cloning }))
const approval = { approver: 'owner-1', role: 'owner', method: 'console', consent_ref: 'consent-2026-001', at: 1 }

test('cloning operations are recognized and speech operations are not', () => {
  for (const op of ['elevenlabs.voice.clone', 'x.voice.convert', 'x.voice.design', 'x.voice.clone.instant'])
    assert.equal(isCloningOperation(op), true, op)
  for (const op of ['elevenlabs.audio.speech', 'openai.chat', 'x.voice.list', 'voice.cloned.audio', ''])
    assert.equal(isCloningOperation(op), false, op)
})

test('a grant without cloning operations needs no approval', () => {
  assert.deepEqual(cloningDecision({ operations: cls(['x.audio.speech']), vendorConsent: false }), { ok: true, cloning: false })
})

test('cloning needs a human owner approval from the console, a consent reference and a vendor consent mechanism', () => {
  const ops = [...cls(['x.audio.speech']), ...cls(['x.voice.clone'], true)]
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

test('the explicit classification drives consent; a mis-named operation cannot bypass it', () => {
  // Classified as cloning although the name looks harmless.
  const sneaky = cls(['x.audio.mimic'], true)
  assert.equal(cloningDecision({ operations: sneaky, vendorConsent: true }).ok, false)
  assert.deepEqual(cloningDecision({ operations: sneaky, approval, vendorConsent: true }), { ok: true, cloning: true })
  // A cloning-looking name classified as standard is still treated as cloning.
  assert.equal(cloningDecision({ operations: cls(['x.voice.clone'], false), vendorConsent: true }).ok, false)
  // A missing classification fails closed.
  assert.equal(cloningDecision({ operations: [{ name: 'x.audio.mimic' } as never], vendorConsent: true }).ok, false)
})
