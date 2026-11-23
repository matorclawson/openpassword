import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'
test('standing draft limit is consumed once, exact replay works while paused', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-draft-'))
  let sends = 0
  const api = service(dir, undefined, async () => {
    sends++
    return Response.json({ id: 'id', status: 'Draft', emailMessageId: 'mail' })
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
  const h = { cookie: String(login.headers['set-cookie']).split(';')[0] }
  const c = (
    await post(
      '/admin/connections',
      { provider: 'loops', label: 'Editorial', external_identity: 'example', secret: 'example' },
      h,
    )
  ).json().connection_id
  const op = 'loops.newsletter.create_campaign'
  const g = (
    await post(
      '/admin/grants',
      { connection_id: c, operations: [op], hours: 1, label: 'Writer', draft_limit: 1 },
      h,
    )
  ).json()
  const invoke = (key: string) =>
    post(
      '/v1/operations/' + op + ':invoke',
      {
        connection_id: c,
        arguments: { name: 'Draft one' },
        operation_id: op,
        idempotency_key: key,
      },
      { authorization: 'Bearer ' + g.access_token, 'openpassword-protocol-version': '1' },
    )
  assert.equal((await invoke('one')).json().status, 'confirmed')
  await post('/admin/dispatch', { paused: true }, h)
  assert.equal((await invoke('one')).json().receipt.replayed, true)
  assert.equal((await invoke('two')).statusCode, 423)
  await post('/admin/dispatch', { paused: false }, h)
  assert.equal((await invoke('two')).json().status, 'approval_required')
  assert.equal(sends, 1)
})

test('Loops created-object checks bind draft changes and suppress signed upload links on replay', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-editor-'))
  const prefix = 'loops.newsletter.'
  const ops = [
    'create_campaign',
    'update_email_message',
    'update_campaign_audience',
    'create_upload',
    'complete_upload',
  ].map((x) => prefix + x)
  const signed = 'https://loops-assets.s3.amazonaws.com/uploads/asset?signature=temporary'
  const api = service(dir, undefined, async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/uploads'))
      return Response.json({ emailAssetId: 'asset', presignedUrl: signed })
    if (path.endsWith('/complete'))
      return Response.json({ emailAssetId: 'asset', finalUrl: 'https://cdn.loops.so/asset' })
    if (path.endsWith('/email-messages/mail')) {
      assert.equal(JSON.parse(String(init?.body)).expectedRevisionId, 'rev1')
      return Response.json({ id: 'mail', contentRevisionId: 'rev2' })
    }
    if (path.endsWith('/campaigns') || path.endsWith('/campaigns/campaign'))
      return Response.json({
        id: 'campaign',
        status: 'Draft',
        emailMessageId: 'mail',
        mailingListId: 'list',
      })
    throw Error('Unexpected provider path')
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
  const h = { cookie: String(login.headers['set-cookie']).split(';')[0] }
  const c = (
    await post(
      '/admin/connections',
      {
        provider: 'loops',
        label: 'Editorial',
        external_identity: 'account',
        secret: 'example',
        resources: ['list'],
      },
      h,
    )
  ).json().connection_id
  const g = (
    await post('/admin/grants', { connection_id: c, label: 'Editor', operations: ops, hours: 2 }, h)
  ).json()
  const invoke = async (op: string, args: object, key = op) => {
    const call = () =>
      post(
        '/v1/operations/' + prefix + op + ':invoke',
        { connection_id: c, operation_id: prefix + op, arguments: args, idempotency_key: key },
        { authorization: 'Bearer ' + g.access_token, 'openpassword-protocol-version': '1' },
      )
    let result = (await call()).json()
    if (result.status === 'approval_required') {
      assert.equal(
        (await post('/admin/approvals/' + result.execution_id, { approve: true }, h)).statusCode,
        200,
      )
      result = (await call()).json()
    }
    return result
  }
  assert.equal((await invoke('create_campaign', { name: 'Draft' })).status, 'confirmed')
  const args = {
    campaign_id: 'campaign',
    email_message_id: 'mail',
    expected_revision_id: 'rev1',
    subject: 'News',
    preview_text: 'Preview',
    from_name: 'Editor',
    from_email: 'editor',
    lmx: '<p>Draft</p>',
  }
  assert.equal((await invoke('update_email_message', args)).result?.content_revision_id, 'rev2')
  assert.equal(
    (await invoke('update_campaign_audience', { campaign_id: 'campaign', mailing_list_id: 'list' }))
      .result?.mailing_list_id,
    'list',
  )
  const upload = { content_type: 'image/png', content_length: 22, sha256: 'a'.repeat(64) }
  assert.equal((await invoke('create_upload', upload)).result?.upload_url, signed)
  assert.equal((await invoke('create_upload', upload)).result?.upload_url, null)
  assert.equal(
    (await invoke('complete_upload', { email_asset_id: 'asset' })).result?.final_url,
    'https://cdn.loops.so/asset',
  )
  assert.equal(
    (await invoke('update_email_message', { ...args, email_message_id: 'someone-else' }, 'wrong'))
      .status,
    'ambiguous',
  )
})
