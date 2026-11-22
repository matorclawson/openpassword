import test from 'node:test'
import assert from 'node:assert/strict'
import { templatePlan, writeTemplate } from '../server/template.ts'
import { bundleHash, templateOps } from '../server/template-preview.ts'
import { digest } from '../server/store.ts'
test('template publish rereads every draft, checks canonical digest, and writes only selected paths', async () => {
  const path = 'editorial/v2/fields.json',
    approved = '[{"name":"title"}]',
    hash = bundleHash([[path, digest(approved)]])
  let writes = 0,
    remote = '[{"name":"title","required":true}]',
    checks = 0
  const send: typeof fetch = async (url, o) => {
    if (o?.method === 'PUT') {
      assert.equal(
        String(url),
        'https://api.hubapi.com/cms/v3/source-code/published/content/' + path,
      )
      writes++
      return new Response()
    }
    return new Response(remote)
  }
  const plan = () =>
    templatePlan(templateOps[1], { paths: [path], bundle_sha256: hash }, ['editorial/v2/'])
  await assert.rejects(
    writeTemplate(plan(), 'token', send, () => {
      checks++
    }),
    /digest/,
  )
  assert.equal(writes, 0)
  remote = '[{"name":"title","required":false}]'
  assert.equal(
    (
      await writeTemplate(plan(), 'token', send, () => {
        checks++
      })
    ).delivery_state,
    'published',
  )
  assert.equal(writes, 1)
  assert.equal(checks, 3)
  assert.throws(() =>
    templatePlan(templateOps[1], { paths: ['other/v2/fields.json'], bundle_sha256: hash }, [
      'editorial/v2/',
    ]),
  )
  assert.throws(() =>
    templatePlan(templateOps[0], { files: [{ path, content: '[]' }], bundle_sha256: hash }, [
      'editorial/v2/',
    ]),
  )
})
