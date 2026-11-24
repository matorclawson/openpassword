import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { service } from '../server/service.ts'
import { store } from '../server/store.ts'

test('CLI host proof issues expiring, replaceable, setup-only codes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-setup-'))
  const origin = 'https://vault.example.com'
  const api = service(dir, origin)
  const address = await api.listen({ host: '127.0.0.1', port: 0 })
  const db = new DatabaseSync(join(dir, 'vault.sqlite'))
  t.after(async () => {
    db.close()
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const post = (url: string, payload: object) => api.inject({ method: 'POST', url, payload })
  const mint = async () =>
    (
      await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'packages/cli/index.ts', 'setup-code'],
        {
          env: { ...process.env, OPENPASSWORD_HOME: dir, OPENPASSWORD_PORT: new URL(address).port },
        },
      )
    ).stdout.trim()
  const hostProof = readFileSync(join(dir, 'operator.token'), 'utf8')
  const oldSession = await post('/admin/login', { token: hostProof })
  const cookie = String(oldSession.headers['set-cookie']).split(';')[0]
  const setup = (token: string) =>
    post('/auth/setup', { token, username: 'first', password: 'synthetic password' })
  assert.equal(
    (
      await post('/auth/setup-code', {
        hash: '0'.repeat(64),
        issued: Date.now(),
        proof: '0'.repeat(64),
      })
    ).statusCode,
    403,
  )
  const first = await mint()
  const second = await mint()
  assert.notEqual(second, hostProof)
  assert.equal((await setup(first)).statusCode, 403)
  assert.equal((await setup(hostProof)).statusCode, 403)
  assert.equal((await post('/admin/login', { token: second })).statusCode, 401)
  db.exec('UPDATE setup_ticket SET expires=0')
  assert.equal((await setup(second)).statusCode, 403)
  const last = await mint()
  assert.equal((await setup(last)).statusCode, 200)
  assert.equal((await setup(last)).statusCode, 409)
  assert.equal((await api.inject({ url: '/profile', headers: { cookie } })).statusCode, 401)
  await assert.rejects(mint)
})

test('vault keys fail closed on unsafe permissions and sealed values are context-bound', () => {
  const dir = mkdtempSync(join(tmpdir(), 'key-guard-'))
  try {
    const vault = store(dir)
    try {
      const a = vault.seal('fixture', 'item-a')
      assert.notEqual(a, vault.seal('fixture', 'item-a'))
      assert.throws(() => vault.open(a, 'item-b'))
      const [key, data] = a.split('.')
      const changed = Buffer.from(data, 'base64')
      changed[12] ^= 1
      assert.throws(() => vault.open(key + '.' + changed.toString('base64'), 'item-a'))
    } finally {
      vault.db.close()
    }
    chmodSync(join(dir, 'master.key'), 0o644)
    assert.throws(() => store(dir), /private regular files/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('external key protects new and migrated vault snapshots, including after restart', async (t) => {
  const { wrapExistingMaster } = await import('../server/store.ts')
  const { mkdirSync, writeFileSync, cpSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'wrapped-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'external')
  writeFileSync(file, '12'.repeat(32), { mode: 0o600 })
  for (const migrate of [false, true]) {
    const dir = join(root, String(migrate))
    mkdirSync(dir)
    const first = store(dir, migrate ? undefined : file)
    const value = first.seal('synthetic', 'item')
    first.db.close()
    if (migrate) {
      assert.throws(() => store(dir, file), /Wrap the existing/)
      wrapExistingMaster(dir, file)
      wrapExistingMaster(dir, file)
    }
    const backup = dir + '-restored'
    cpSync(dir, backup, { recursive: true })
    assert.throws(() => store(backup), /Wrapped vault requires/)
    writeFileSync(file, '34'.repeat(32))
    assert.throws(() => store(backup, file))
    writeFileSync(file, '12'.repeat(32))
    const restored = store(backup, file)
    try {
      assert.equal(restored.open(value, 'item'), 'synthetic')
    } finally {
      restored.db.close()
    }
  }
})
