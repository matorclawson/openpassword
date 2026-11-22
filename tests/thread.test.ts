import test from 'node:test'
import assert from 'node:assert/strict'
import { xThread } from '../packages/connectors/x-thread.ts'
test('thread plan binds each reply to the exact prior receipt', () => {
  const thread = xThread('123', [
    { text: 'First', reply_to_prior_index: null },
    { text: 'Next', media_ids: ['314'], reply_to_prior_index: 0 },
  ])
  const first = thread.next([])!.step
  assert.equal(thread.next([first]), null)
  assert.equal(thread.next([{ ...first, returned_id: 'UNKNOWN' }]), null)
  const prior = { ...first, returned_id: '987' }
  assert.deepEqual(thread.next([prior])!.arguments, {
    text: 'Next',
    media: { media_ids: ['314'] },
    reply: { in_reply_to_tweet_id: '987' },
  })
  assert.throws(() => thread.next([{ ...prior, request_digest: 'invalid' }]))
  assert.equal(thread.next([prior, { ...thread.next([prior])!.step, returned_id: '999' }]), null)
})
