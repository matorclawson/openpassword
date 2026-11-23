import { Ajv2020 } from 'ajv/dist/2020.js'
import schema from './batch-view.schema.json' with { type: 'json' }
import type { DatabaseSync } from 'node:sqlite'
import { digest } from './store.ts'
const validator = new Ajv2020({ strict: false }).compile(schema)
type Row = Record<string, any>
export function validBatchView(value: unknown) {
  if (!validator(value)) return false
  const v = value as Row,
    t = v.tallies
  return (
    t.sent === t.accepted + t.refused + t.ambiguous &&
    [v.window.not_before, v.window.expires_at, v.window.decided_at].every(
      (s) =>
        s === null ||
        (Number.isFinite(Date.parse(s)) &&
          new Date(Date.parse(s)).toISOString().replace('.000Z', 'Z') === s),
    )
  )
}
export function batchView(db: DatabaseSync, b: Row) {
  const m = JSON.parse(b.manifest),
    named = (id: string, label: string) => ({
      id,
      label: /^[A-Za-z0-9 ._:/,()'"\[\]+-]{1,120}(?![\s\S])/.test(label)
        ? label
        : 'name withheld [' + id.slice(0, 80) + ']',
    })
  const lookup = (sql: string, id: string) => String(db.prepare(sql).get(id)?.label ?? id)
  const actor = named(b.actor, lookup('SELECT label FROM grants WHERE id=?', b.actor))
  let state = b.state,
    reason = b.reason
  if (state === 'denied') {
    state = 'voided'
    reason = 'voided'
  } else if (state === 'claimed') {
    state = 'running'
    reason = null
  }
  if (
    ['pending', 'approved', 'running'].includes(state) &&
    Date.now() >= Date.parse(m.window.expires_at)
  ) {
    state = 'expired'
    reason = 'window_expired'
  }
  if (['bad_row', 'duplicate_in_chunk'].includes(reason)) reason = 'not_normalized'
  const decision = db
    .prepare('SELECT decided FROM batch_decisions WHERE approval=?')
    .get(b.approval)
  const view = {
    schema: 'openpassword-batch-approval-view/1',
    approval_id: b.approval,
    action: 'import',
    operation_id: m.operation,
    organization: named(b.tenant, lookup('SELECT label FROM workspaces WHERE id=?', b.tenant)),
    connection: named(b.conn, lookup('SELECT label FROM connections WHERE id=?', b.conn)),
    list: named(m.list_id, m.list_name),
    rows: m.row_count,
    chunk_count: m.chunk_count,
    chunk_size: m.chunk_size,
    batch_sha256: digest(JSON.stringify(m.chunk_digests)),
    manifest_sha256: b.hash,
    properties_allowed: m.properties_allowed,
    requested_by: { application: actor, device: actor },
    window: {
      ...m.window,
      decided_at: decision
        ? new Date(Number(decision.decided)).toISOString().replace(/\.\d{3}Z$/, 'Z')
        : null,
    },
    state,
    reason,
    workflows: m.workflows,
    tallies: {
      sent: b.sent,
      accepted: b.accepted,
      refused: b.refused,
      ambiguous: b.ambiguous,
      chunks_done: b.idx,
    },
  }
  if (!validBatchView(view)) throw Error('Batch view unreadable')
  return view
}
