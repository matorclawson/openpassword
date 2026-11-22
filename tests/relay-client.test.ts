import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { OpenPassword } from '../packages/client/index.ts'
test('relay client probes after a lost acknowledgement and resumes after the accepted bytes', async (t) => {
  const media = new Blob(['hello world']),
    session = {
      connection_id: 'conn',
      upload_url: 'https://example.invalid/relay',
      relay_seal: 'seal',
      mime_type: 'text/vtt',
      size_bytes: media.size,
      content_sha256: createHash('sha256').update('hello world').digest('hex'),
    }
  const ranges: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, o: RequestInit) => {
    assert.equal(url, 'http://localhost/v1/youtube/uploads:relay')
    const h = new Headers(o.headers)
    assert.equal(h.get('Authorization'), 'Bearer local')
    ranges.push(h.get('x-zeo-content-range')!)
    if (ranges.length === 2) throw Error('lost')
    const body =
      ranges.length === 1
        ? { status: 308, range: null }
        : ranges.length === 3
          ? { status: 308, range: 'bytes=0-4' }
          : { status: 201, resource: { id: 'example' } }
    if (ranges.length === 4) assert.equal(await (o.body as Blob).text(), ' world')
    return Response.json(body, { headers: { 'openpassword-protocol-version': '1' } })
  })
  const client = new OpenPassword('http://localhost', 'local')
  await assert.rejects(
    client.uploadYouTube({ ...session, content_sha256: 'incorrect' }, media),
    /digest/,
  )
  assert.equal((await client.uploadYouTube(session, media)).id, 'example')
  assert.deepEqual(ranges, ['bytes */11', 'bytes 0-10/11', 'bytes */11', 'bytes 5-10/11'])
})
