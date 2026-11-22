import { checkContactEmail } from '../packages/connectors/contact-email.ts'
import { approvalSnapshot, snapshotDigest } from '../server/snapshot.ts'
import { bundleHash } from '../server/template-preview.ts'
// Optional differential checks. Pass the source checkout for the pinned reference.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { validBatchView } from '../server/batch-view.ts'
import { admitGithub } from '../server/keymaster.ts'
const dir = join(process.argv[2] ?? '', 'contract', 'fixtures')
// The reference fixtures use the predecessor's identifier prefix. Set REFERENCE_ID_PREFIX to it
// (for example 'old-name-') and quoted identifiers starting with it are read as 'openpassword-'.
const prefix = process.env.REFERENCE_ID_PREFIX ?? ''
const read = (...parts: string[]) => {
  const text = readFileSync(join(dir, ...parts), 'utf8')
  return JSON.parse(prefix ? text.replaceAll('"' + prefix, '"openpassword-') : text)
}
let batch = 0,
  requests = 0
for (const file of readdirSync(join(dir, 'batch-view-1')).filter((f) => f.startsWith('fixture-'))) {
  assert.equal(validBatchView(read('batch-view-1', file)), !file.startsWith('fixture-neg'), file)
  batch++
}
for (const file of ['1.4.0-annex-a.json', '1.4.1-annex-b.json']) {
  for (const c of read(file).cases) {
    if (!c.schema.endsWith(':request')) continue
    const answer = admitGithub(
      c.instance.operation_id,
      JSON.stringify(c.instance),
      /:1\.4\.1:request$/.test(c.schema),
    )
    assert.equal(answer.status === 503, c.valid, c.name)
    requests++
  }
}
console.log(batch + ' batch-view fixtures and ' + requests + ' Annex request fixtures passed')

let snapshots = 0
for (const file of readdirSync(join(dir, 'approval-snapshot-1'))) {
  const v = read('approval-snapshot-1', file)
  if (!v.device) {
    assert.equal(bundleHash(v.pairs), v.bundle_sha256, file)
  } else {
    const s = approvalSnapshot(v.operation_id, v.arguments, v.device, v.draft_url)
    assert.deepEqual(s, v.snapshot, file)
    if (s) assert.equal(snapshotDigest(s), v.snapshot_digest, file)
  }
  snapshots++
}
console.log(snapshots + ' snapshot and bundle fixtures passed')

const addresses = read('batch-view-1', 'normalisation-vectors.json').vectors
for (const v of addresses) assert.equal(checkContactEmail(v.input), v.result)
console.log(addresses.length + ' email normalization vectors passed')

const catalogue = readFileSync(join(dir, '../../app/provider_catalogue.py'), 'utf8')
const table = catalogue.split('    definitions = (')[1].split('    return tuple(')[0]
const upstream = Array.from(table.matchAll(/"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)"/g), (m) => m[1])
const { providers } = await import('../packages/connectors/index.ts')
const actions = Object.values(providers).flatMap((p) => p.actions.map((a) => a.id))
const missing = upstream.filter((op) => !actions.includes(op))
assert.ok(upstream.length >= 35)
console.log(
  upstream.length -
    missing.length +
    ' of ' +
    upstream.length +
    ' default operation names present; missing: ' +
    missing.join(', '),
)
console.log(
  Object.keys(providers).length + ' provider entries, ' + actions.length + ' registered actions',
)
