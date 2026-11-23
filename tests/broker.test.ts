import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'
import { providers, buildRequest } from '../packages/connectors/index.ts'

test('device lease, exact approval, replay, account isolation, rotation and restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-test-'))
  let sends = 0
  const send: typeof fetch = async (url, init) => {
    sends++
    assert.equal(new URL(String(url)).origin, 'https://api.x.com')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-secret-example')
    return Response.json({ data: { id: '123' } })
  }
  let app = service(dir, undefined, send)
  t.after(async () => {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  })
  let cookie = '',
    bearer = ''
  const call = async (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: object,
    expected = 200,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url,
      payload,
      headers: {
        'openpassword-protocol-version': '1',
        cookie,
        authorization: 'Bearer ' + bearer,
        ...headers,
      },
    })
    assert.equal(res.statusCode, expected, res.body)
    return res
  }
  const login = await call('POST', '/admin/login', {
    token: readFileSync(join(dir, 'operator.token'), 'utf8'),
  })
  cookie = String(login.headers['set-cookie']).split(';')[0]
  await call('POST', '/admin/workspaces', { label: 'forbidden' }, 403, {
    origin: 'https://example.invalid',
  })
  const c = (
    await call('POST', '/admin/connections', {
      provider: 'x',
      label: 'News',
      external_identity: 'example',
      secret: 'test-secret-example',
    })
  ).json().connection_id
  const pair = (
    await call('POST', '/v1/device/authorizations', { device_name: 'Editorial CLI' })
  ).json()
  await call('POST', '/v1/device/token', { device_code: pair.device_code }, 428)
  const grant = (
    await call('POST', '/admin/grants', {
      label: 'Editorial CLI',
      connection_id: c,
      operations: ['x.publish'],
      hours: 2,
      user_code: pair.user_code,
    })
  ).json()
  const device = (await call('POST', '/v1/device/token', { device_code: pair.device_code })).json()
  await call('POST', '/v1/device/token', { device_code: pair.device_code }, 400)
  bearer = device.access_token
  const list = (await call('GET', '/v1/connections')).json()
  assert.equal(list.length, 1)
  assert.equal(list[0].connection_revision, undefined)
  const hdr = { 'openpassword-capabilities': 'expected-binding' }
  assert.equal(
    (await call('GET', '/v1/connections', undefined, 200, hdr)).json()[0].connection_revision,
    '1',
  )
  const url = '/v1/operations/x.publish:invoke',
    body = {
      connection_id: c,
      operation_id: 'x.publish',
      idempotency_key: 'post-1',
      arguments: { text: 'Example' },
      expect: { external_identity: 'example', connection_revision: '1' },
    }
  const first = (await call('POST', url, body, 200, hdr)).json()
  assert.equal(first.status, 'approval_required')
  assert.equal(sends, 0)
  const w = (await call('POST', '/admin/workspaces', { label: 'Second workspace' })).json()
  await call('POST', '/admin/switch', w)
  const other = (await call('GET', '/admin/workspace')).json()
  assert.equal(other.connections.length, 0)
  assert.equal(other.approvals.length, 0)
  await call('POST', '/admin/approvals/' + first.execution_id, { approve: true }, 409)
  await call('POST', '/admin/switch', { id: 'default' })
  await call('POST', '/admin/approvals/' + first.execution_id, { approve: true })
  await call('POST', '/admin/dispatch/x/x.publish', { paused: true })
  await call('POST', url, body, 423, hdr)
  assert.equal(sends, 0)
  await call('POST', '/admin/dispatch/x/x.publish', { paused: false })
  const outcomes = await Promise.all([
    call('POST', url, body, 200, hdr),
    call('POST', url, body, 200, hdr),
  ])
  assert.equal(outcomes[0].json().status, 'confirmed')
  assert.equal(sends, 1)
  await app.close()
  app = service(dir, undefined, send)
  assert.equal((await call('POST', url, body, 200, hdr)).json().receipt.replayed, true)
  assert.equal(sends, 1)
  await call('POST', url, { ...body, arguments: { text: 'different' } }, 400, hdr)
  await call('POST', '/admin/connections/' + c + '/rotate', { secret: 'rotated-example' })
  await call('POST', url, { ...body, idempotency_key: 'post-2' }, 400, hdr)
  const rotated = (
    await call('POST', '/v1/device/token/refresh', { refresh_token: device.refresh_token })
  ).json()
  await call('GET', '/v1/connections', undefined, 401)
  bearer = rotated.access_token
  await call('POST', '/v1/device/token/refresh', { refresh_token: device.refresh_token }, 401)
  await call('DELETE', '/admin/grants/' + grant.device_id)
  await call('GET', '/v1/connections', undefined, 401)
  for (const file of ['vault.sqlite', 'vault.sqlite-wal'])
    assert.equal(readFileSync(join(dir, file)).includes('test-secret-example'), false)
})
for (const [id, p] of Object.entries(providers))
  test(id + ' builds all registered operations', () => {
    for (const a of p.actions) {
      const params = Array.from(a.path.matchAll(/\{(\w+)\}/g), (m) => m[1])
      const args: Record<string, any> = Object.fromEntries(
        [...a.required, ...params].map((k) => [k, 'sample']),
      )
      if (id === 'tiktok' && args.video_url) {
        args.video_url = 'https://example.invalid/video.mp4'
        if (args.privacy_level) args.privacy_level = 'SELF_ONLY'
      }
      if (a.id === 'loops.newsletter.create_upload')
        Object.assign(args, {
          content_type: 'image/png',
          content_length: 10,
          sha256: 'a'.repeat(64),
        })
      if (a.id === 'loops.newsletter.update_campaign_audience') args.mailing_list_id = 'selected'
      if (args.account_id) args.account_id = '12345678-1234-1234-1234-123456789012'
      if (id === 'supabase_data')
        Object.assign(args, {
          ...(a.body.includes('row') ? { row: { id: 1 } } : {}),
          ...(a.body.includes('match') ? { match: { id: 1 } } : {}),
          ...(a.body.includes('on_conflict') ? { on_conflict: 'id' } : {}),
        })
      if (a.id === 'kit.newsletter.create_draft')
        args.draft = {
          subject: 'Draft',
          content: 'words',
          email_address: 'editor@example.invalid',
          email_template_id: 1,
          audience: { entire_account: true },
        }
      if (['hubspot.newsletter.create_draft', 'hubspot.newsletter.update_draft'].includes(a.id))
        args.draft = {
          name: 'Draft',
          subject: 'words',
          from_name: 'Editor',
          from_email: 'editor@example.invalid',
          content: { plain_text: 'sample' },
        }
      if (a.id.endsWith('.batch_update')) args.requests = []
      if (id === 'google_sheets')
        Object.assign(args, {
          spreadsheet_id: 'a'.repeat(24),
          ...(a.id === 'sheets.batch_get' ? { ranges: ['Sheet!A1'] } : { range: 'Sheet!A1' }),
          ...(a.id === 'sheets.append_rows'
            ? { rows: [[1]] }
            : a.id === 'sheets.update_range'
              ? { values: [[1]] }
              : {}),
        })
      const r = buildRequest(
        id,
        a.id,
        args,
        id === 'supabase_data'
          ? JSON.stringify({ project: 'a'.repeat(20), key: 'example' })
          : id === 'twilio'
            ? 'AC' + '0'.repeat(32) + ':example'
            : 'example',
      )
      assert.equal(r.url.protocol, 'https:')
      assert.equal(r.init.redirect, 'error')
      assert.throws(() =>
        buildRequest(id, a.id, { ...args, url: 'https://example.invalid' }, 'token'),
      )
    }
  })
test('Revolut wire projection drops cardholder fields and preserves exact decimal strings', async () => {
  const { revolutTransactions } = await import('../packages/connectors/revolut.ts')
  const account_id = '12345678-1234-1234-1234-123456789012',
    instant = '2026-11-22T01:02:03Z'
  const data = [
    {
      id: 'transaction',
      created_at: instant,
      updated_at: instant,
      state: 'completed',
      type: 'card_payment',
      card: { id: account_id, card_number: 'removed' },
      legs: [
        { leg_id: account_id, account_id, amount: '12345678901234567890.0100', currency: 'GBP' },
      ],
    },
  ]
  const page = revolutTransactions(data, { account_id, count: 1 })
  assert.equal(page.transactions[0].legs[0].amount, '12345678901234567890.0100')
  assert.deepEqual(page.transactions[0].card, { id: account_id })
  assert.throws(() => revolutTransactions(data, { account_id, to: instant, count: 1 }), /stalled/)
})

test('Supabase writes keep the selected table and equality filter and reject unbounded changes', () => {
  const token = JSON.stringify({ project: 'a'.repeat(20), key: 'example' })
  const req = (op: string, args: Record<string, unknown>) =>
    buildRequest('supabase_data', 'supabase.rows.' + op, { table: 'articles', ...args }, token)
  assert.throws(() => req('read', { select: '*,secrets(*)' }))
  assert.throws(() => req('update', { row: { title: 'Replacement' }, match: {} }))
  assert.throws(() => req('delete', { match: { limit: 1 } }))
  const change = req('update', { row: { title: 'Replacement' }, match: { id: 7 } })
  assert.equal(change.url.searchParams.get('id'), 'eq.7')
  assert.equal(change.init.body, '{"title":"Replacement"}')
  const upsert = req('upsert', { row: { id: 7 }, on_conflict: 'id' })
  assert.equal(upsert.url.searchParams.get('on_conflict'), 'id')
  assert.equal(upsert.init.headers.Prefer, 'resolution=merge-duplicates,return=representation')
})
