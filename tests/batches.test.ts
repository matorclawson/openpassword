import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { service } from '../server/service.ts'
test('manifest binds list and exact rows, repeats never import twice, workflow rechecked', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-batch-'))
  let writes = 0,
    checks = 0
  const api = service(dir, undefined, async (url, init) => {
    if (String(url).includes('workflows')) {
      checks++
      return Response.json({ data: [], pagination: {} })
    }
    assert.equal(init?.method, 'PUT')
    assert.deepEqual(JSON.parse(String(init?.body)).mailingLists, { 'example-list': true })
    writes++
    return Response.json({ success: true })
  })
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    api.inject({ method: 'POST', url, payload, headers })
  const login = await post('/admin/login', {
    token: readFileSync(join(dir, 'operator.token'), 'utf8'),
  })
  const h = { cookie: String(login.headers['set-cookie']).split(';')[0] },
    op = 'loops.contacts.import_chunk'
  const c = (
    await post(
      '/admin/connections',
      {
        provider: 'loops',
        label: 'Marketing',
        external_identity: 'Team',
        secret: 'example-only',
        resources: ['example-list'],
      },
      h,
    )
  ).json().connection_id
  const g = (
    await post(
      '/admin/grants',
      { connection_id: c, operations: [op], label: 'Importer', hours: 1 },
      h,
    )
  ).json()
  const headers = { authorization: 'Bearer ' + g.access_token, 'zeoconnect-protocol-version': '1' }
  const invoke = async (args: object, key: string) =>
    (
      await post(
        '/v1/operations/' + op + ':invoke',
        { connection_id: c, operation_id: op, arguments: args, idempotency_key: key },
        headers,
      )
    ).json()
  const rows = [{ email: 'dev@example.com', user_id: '12345678-1234-4234-9234-123456789abc' }]
  const ts = (delta: number) => new Date(Date.now() + delta).toISOString().replace(/\.\d{3}/, '')
  const manifest = {
    schema: 'zeoconnect-batch-manifest/1',
    operation: op,
    organization: 'default',
    connection: c,
    list_id: 'example-list',
    list_name: 'Example',
    row_count: 1,
    chunk_size: 1,
    chunk_count: 1,
    chunk_counts: [1],
    chunk_digests: [createHash('sha256').update(JSON.stringify(rows)).digest('hex')],
    properties_allowed: [],
    policy_id: 'policy',
    policy_revision: '1',
    record_id: 'example',
    run_id: 'example',
    snapshot_version: '1',
    reason_code: 'import',
    distinct_attested: { email: true, user_id: true },
    window: { not_before: ts(-2000), expires_at: ts(60000) },
  }
  const pending = await invoke({ manifest }, 'manifest')
  assert.equal(pending.status, 'approval_required')
  const chunk = { batch_id: pending.receipt.batch_id, index: 0, rows }
  assert.equal((await invoke(chunk, 'chunk')).status, 'refused')
  await post('/admin/approvals/' + pending.execution_id, { approve: true }, h)
  assert.equal((await invoke(chunk, 'chunk')).result.state, 'done')
  assert.equal((await invoke(chunk, 'chunk')).receipt.replayed, true)
  assert.equal(writes, 1)
  assert.equal(checks, 2)
})
