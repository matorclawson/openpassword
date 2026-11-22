import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { service } from '../server/service.ts'
test('wire protocol version precedes request body parsing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'op-protocol-')),
    api = service(dir)
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  for (const [headers, reason] of [
    [{}, 'header_missing'],
    [{ 'zeoconnect-protocol-version': '2' }, 'version_unsupported'],
    [{ 'zeoconnect-protocol-version': '1, 1' }, 'header_duplicated'],
  ] as const) {
    const res = await api.inject({
      method: 'POST',
      url: '/v1/device/token',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '{',
    })
    assert.equal(res.statusCode, 426)
    assert.equal(res.json().reason, reason)
    assert.equal(res.headers['zeoconnect-protocol-version'], '1')
  }
})
