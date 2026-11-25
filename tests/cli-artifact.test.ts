import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const id = 'art_123e4567-e89b-12d3-a456-426614174000'
// Deliberately not canonical JSON: the command must write the bytes it received, unchanged.
const body = Buffer.from('{ "schema_version": 2,\n  "messages": [] , "next_cursor": null }\n')
const sha = createHash('sha256').update(body).digest('hex')

function run(env: Record<string, string>, ...args: string[]) {
  return new Promise<{ code: number; stdout: Buffer; stderr: string }>((done) => {
    execFile(
      process.execPath,
      [resolve('packages/cli/dist/index.js'), ...args],
      { env, encoding: 'buffer' },
      (error, stdout, stderr) =>
        done({
          code: error ? Number((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr: stderr.toString(),
        }),
    )
  })
}

test('artifact command writes the exact bytes, verifies a digest and refuses bad input', async (t) => {
  const seen: { url: string; authorization?: string; version?: string }[] = []
  const server = createServer((req, res) => {
    seen.push({
      url: String(req.url),
      authorization: req.headers.authorization,
      version: String(req.headers['openpassword-protocol-version']),
    })
    res.setHeader('OpenPassword-Protocol-Version', '1')
    if (req.url === '/v1/artifacts/' + id && req.headers.authorization === 'Bearer test-access') {
      res.setHeader('Content-Type', 'application/json').end(body)
    } else {
      res.statusCode = 404
      res.end('{"detail":"Artifact unavailable"}')
    }
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const home = mkdtempSync(join(tmpdir(), 'op-cli-artifact-'))
  t.after(() => {
    server.close()
    rmSync(home, { recursive: true, force: true })
  })
  // A paired device whose access token is still valid, so no refresh call is made.
  const dir = join(home, '.config/openpassword')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(dir, 'devices.sqlite'))
  db.exec('CREATE TABLE identities(origin TEXT PRIMARY KEY,tokens TEXT)')
  db.prepare('INSERT INTO identities VALUES(?,?)').run(
    origin,
    JSON.stringify({
      device_id: 'device-example',
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      access_expires_at: new Date(Date.now() + 600000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 86400000).toISOString(),
    }),
  )
  db.close()
  const env = { HOME: home, OPENPASSWORD_BROKER: origin, PATH: process.env.PATH ?? '' }

  const plain = await run(env, 'artifact', id)
  assert.equal(plain.code, 0, plain.stderr)
  assert.deepEqual(plain.stdout, body)
  assert.equal(seen.at(-1)?.authorization, 'Bearer test-access')
  assert.equal(seen.at(-1)?.version, '1')

  const checked = await run(env, 'artifact', id, 'sha256:' + sha)
  assert.equal(checked.code, 0, checked.stderr)
  assert.deepEqual(checked.stdout, body)
  assert.equal((await run(env, 'artifact', id, sha)).code, 0)

  const wrong = await run(env, 'artifact', id, '0'.repeat(64))
  assert.notEqual(wrong.code, 0)
  assert.equal(wrong.stdout.length, 0, 'bytes were written despite a digest mismatch')
  assert.match(wrong.stderr, /differs from the expected digest/)

  const before = seen.length
  for (const bad of [['artifact'], ['artifact', '../x'], ['artifact', 'art_x'], ['artifact', id, 'nothex']]) {
    const r = await run(env, ...bad)
    assert.notEqual(r.code, 0, bad.join(' '))
    assert.equal(r.stdout.length, 0)
  }
  assert.equal(seen.length, before, 'a malformed request reached the broker')

  const missing = await run(env, 'artifact', 'art_00000000-0000-0000-0000-000000000000')
  assert.notEqual(missing.code, 0)
  assert.match(missing.stderr, /Broker returned 404/)
  assert.equal(missing.stdout.length, 0)
})
