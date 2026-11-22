import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequest, googleBatch, slideObjectId } from '../packages/connectors/index.ts'
test('Docs dispatch orders edits by decreasing UTF-16 anchor; Slides and Sheets preserve dependencies', () => {
  const requests = [
    { replaceAllText: {} },
    { insertText: { location: { index: 2 } } },
    { updateTextStyle: { range: { startIndex: 6 } } },
    { insertText: { location: { index: 6 } } },
  ]
  const sent = buildRequest(
    'google_workspace',
    'google.docs.batch_update',
    { id: 'document', requests },
    'token',
  )
  assert.deepEqual(JSON.parse(String(sent.init.body)).requests, [
    requests[2],
    requests[3],
    requests[1],
    requests[0],
  ])
  assert.deepEqual(googleBatch('slides', requests), requests)
  assert.deepEqual(googleBatch('sheets', requests), requests)
  assert.match(slideObjectId('slide'), /^slide_[0-9a-f]{32}$/)
})
