import test from 'node:test'
import assert from 'node:assert/strict'
import { PublishingJournal } from '../packages/client/publishing.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
test('publishing recovers exact approved requests, resolves receipts and polls with fresh observation keys', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-journal-')),
    path = join(dir, 'journal.sqlite')
  let journal = new PublishingJournal(path)
  t.after(() => {
    journal.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const d = {
    title: 'Example',
    scheduled_at: '2020-01-01T00:00:00Z',
    targets: [
      {
        target_id: 'social',
        platform: 'threads',
        connection_id: 'team',
        expect: { external_identity: 'actor', connection_revision: '1' },
        steps: [
          {
            step_id: 'draft',
            operation_id: 'threads.draft',
            kind: 'effect',
            arguments: { text: 'Example' },
          },
          {
            step_id: 'check',
            operation_id: 'threads.status',
            kind: 'read',
            arguments: { id: { $step: 'draft', field: 'container_id' } },
            wait_field: 'status',
            pending_values: ['PROCESSING'],
            ready_values: ['READY'],
            poll_seconds: 1,
          },
          {
            step_id: 'post',
            operation_id: 'threads.publish',
            kind: 'effect',
            arguments: { creation_id: { $step: 'draft', field: 'container_id' } },
          },
        ],
      },
    ],
  }
  const saved = journal.save('org', 'post', 'editor', 0, d)
  assert.throws(() => journal.approve('org', 'post', 'owner', 'wrong'))
  journal.approve('org', 'post', 'owner', saved.digest)
  let calls = 0
  const keys: string[] = []
  const run = (now = Date.now()) =>
    journal.tick(
      'org',
      async (req) => {
        keys.push(req.idempotency_key)
        calls++
        if (calls === 1) return { status: 'approval_required' }
        if (calls === 2) return { status: 'confirmed', result: { container_id: '123' } }
        if (calls <= 4) {
          assert.equal(req.arguments.id, '123')
          return { status: 'confirmed', result: { status: calls === 3 ? 'PROCESSING' : 'READY' } }
        }
        assert.equal(req.arguments.creation_id, '123')
        return { status: 'confirmed', result: { stage: 'published' } }
      },
      () => {},
      now,
    )
  assert.equal((await run())?.state, 'approval_required')
  journal.close()
  journal = new PublishingJournal(path)
  journal.resume('org', 'post', 'social', 'operator')
  assert.equal((await run())?.state, 'ready')
  assert.equal(keys[0], keys[1])
  assert.equal((await run())?.state, 'waiting')
  assert.equal(await run(), null)
  assert.equal((await run(Date.now() + 2000))?.state, 'ready')
  assert.notEqual(keys[2], keys[3])
  assert.equal((await run())?.state, 'published')
  assert.equal(await run(), null)
  assert.equal(journal.calendar('other', 0, Date.now()).length, 0)
})
