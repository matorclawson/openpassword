import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'
test('Gmail golden wire response, artifact headers, digest and exact bytes', async (t) => {
  const ref = (file: string) =>
    readFileSync(new URL('./fixtures/gmail/' + file, import.meta.url), 'utf8')
  const bytes = ref('page-body.json'),
    page = JSON.parse(bytes),
    m = page.messages[0]
  const dir = mkdtempSync(join(tmpdir(), 'op-mail-'))
  const api = service(dir, undefined, async (u) =>
    Response.json(
      new URL(String(u)).pathname.endsWith('/messages')
        ? { messages: [{ id: m.id }], nextPageToken: 'next-1' }
        : {
            id: m.id,
            threadId: m.thread_id,
            internalDate: String(m.internal_date_ms),
            labelIds: [page.label_id],
            raw: Buffer.from(m.raw_base64, 'base64').toString('base64url'),
          },
    ),
  )
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
    op = 'google.gmail.messages.read_page'
  const c = (
    await post(
      '/admin/connections',
      {
        provider: 'google_workspace',
        label: 'Editorial',
        external_identity: 'example',
        secret: 'test-secret',
        resources: [page.label_id],
      },
      h,
    )
  ).json()
  const g = (
    await post(
      '/admin/grants',
      { label: 'Reader', connection_id: c.connection_id, operations: [op], hours: 1 },
      h,
    )
  ).json()
  const headers = { 'zeoconnect-protocol-version': '1', authorization: 'Bearer ' + g.access_token }
  const response = await post(
    '/v1/operations/' + op + ':invoke',
    {
      connection_id: c.connection_id,
      operation_id: op,
      arguments: {
        label_id: page.label_id,
        starts_at: new Date(m.internal_date_ms - 1).toISOString(),
        ends_at: new Date(m.internal_date_ms + 1).toISOString(),
      },
      idempotency_key: 'golden',
    },
    headers,
  )
  const outcome = response.json(),
    golden = JSON.parse(ref('invoke-response.json'))
  assert.equal(outcome.status, 'confirmed', response.body)
  const id = outcome.artifact.artifact_id
  assert.deepEqual(
    {
      ...outcome,
      execution_id: golden.execution_id,
      artifact: { ...outcome.artifact, artifact_id: golden.artifact.artifact_id },
    },
    golden,
  )
  const artifact = await api.inject({ method: 'GET', url: '/v1/artifacts/' + id, headers })
  assert.equal(artifact.body, bytes)
  assert.equal(
    artifact.headers['content-disposition'],
    JSON.parse(ref('artifact-get.json'))['content-disposition'],
  )
})
