import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { service } from '../server/service.ts'
import { approvalExempt } from '../server/passkeys.ts'
import { DatabaseSync } from 'node:sqlite'
import { upgradePrivateVault } from '../app/upgrade-private-vault.ts'
import {
  importVaultKey,
  newVaultKey,
  derivePrivateKey,
  encryptPrivate,
  decryptPrivate,
  openPrivateValue,
} from '../app/private-crypto.ts'

test('owner upgrades a paginated legacy vault atomically and fences obsolete clients', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'private-upgrade-')),
    api = service(dir)
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const login = await api.inject({
    url: '/admin/login',
    method: 'POST',
    payload: { token: readFileSync(join(dir, 'operator.token'), 'utf8') },
  })
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  const request = async (path: string, body?: object) => {
    const response = await api.inject({
      url: '/' + path,
      method: body ? 'POST' : 'GET',
      payload: body,
      headers: { cookie },
    })
    if (response.statusCode !== 200) throw Error('HTTP ' + response.statusCode)
    return response.json()
  }
  const vault = 'profile/vault',
    begin = vault + '/upgrade'
  const oldKey = await importVaultKey(newVaultKey())
  const { tenant, profile } = await request(vault)
  const ctx = (id: string) => JSON.stringify(['OpenPassword.private.v1', tenant, profile, id])
  const check = await encryptPrivate(oldKey, ctx('unlock'), 'OpenPassword private vault')
  await request(vault, { check })
  const ids = []
  for (let i = 0; i < 26; i++) {
    const id = crypto.randomUUID()
    ids.push(id)
    const value = await encryptPrivate(
      oldKey,
      ctx(id),
      JSON.stringify({
        title: 'item ' + i,
        protectedValue: await encryptPrivate(oldKey, ctx('value/' + id), 'value ' + i),
      }),
    )
    await request(vault + '/items', { id, value, revision: 0 })
  }
  const original = await request(vault),
    first = original.items[0]
  const pending = await request(vault + '/deposits', {
    id: crypto.randomUUID(),
    value: first.value,
  })
  const attempt = (await request(begin, {})).id
  const otherLogin = await api.inject({
    url: '/admin/login',
    method: 'POST',
    payload: { token: readFileSync(join(dir, 'operator.token'), 'utf8') },
  })
  const otherCookie = String(otherLogin.headers['set-cookie']).split(';')[0]
  assert.equal(otherLogin.statusCode, 200)
  assert.notEqual(otherCookie, cookie)
  assert.equal(
    (
      await api.inject({
        url: '/' + begin + '/' + attempt + '/commit',
        method: 'POST',
        payload: { check },
        headers: { cookie: otherCookie },
      })
    ).statusCode,
    409,
  )
  await request(begin + '/' + attempt + '/item', {
    id: first.id,
    revision: first.revision,
    value: first.value,
  })
  await assert.rejects(request(begin + '/' + attempt + '/commit', { check }), /409/)
  assert.deepEqual((await request(vault)).items, original.items)
  await request(vault + '/items', { id: first.id, value: first.value, revision: first.revision })
  await assert.rejects(
    request(begin + '/' + attempt + '/item', {
      id: first.id,
      revision: first.revision + 1,
      value: first.value,
    }),
    /409/,
  )
  const saved = newVaultKey(),
    pass = 'fixture independent passphrase'
  const interrupted = new AbortController()
  await assert.rejects(
    upgradePrivateVault(request, original, oldKey, saved, pass, interrupted.signal, () =>
      interrupted.abort(),
    ),
    { name: 'AbortError' },
  )
  assert.equal((await request(vault)).check, check)
  let count = 0
  let lostReply = false
  await upgradePrivateVault(
    async (path, body) => {
      const result = await request(path, body)
      if (path.endsWith('/commit') && !lostReply) {
        lostReply = true
        throw new TypeError('simulated disconnect after commit')
      }
      return result
    },
    original,
    oldKey,
    saved,
    pass,
    new AbortController().signal,
    (n) => {
      count = n
    },
  )
  assert.equal(lostReply, true)
  assert.equal(count, 26)
  const migrated = await request(vault),
    newKey = await derivePrivateKey(saved, pass, tenant, profile)
  assert.equal(
    await decryptPrivate(newKey, ctx('unlock'), migrated.check),
    'OpenPassword private vault',
  )
  await assert.rejects(decryptPrivate(oldKey, ctx('unlock'), migrated.check))
  const second = await request(vault + '?after=' + migrated.next)
  for (const row of [...migrated.items, ...second.items]) {
    const item = JSON.parse(await decryptPrivate(newKey, ctx(row.id), row.value))
    assert.equal(
      await openPrivateValue(newKey, ctx('value/' + row.id), item),
      'value ' + ids.indexOf(row.id),
    )
    assert.ok(row.revision >= 2)
  }
  const insert = { id: crypto.randomUUID(), value: first.value, revision: 0 }
  await assert.rejects(request(vault + '/items', insert), /409/)
  await assert.rejects(request(vault + '/deposits', { id: insert.id, value: insert.value }), /409/)
  assert.equal(
    (
      await api.inject({
        method: 'DELETE',
        url: '/' + vault + '/items/' + first.id,
        headers: { cookie },
      })
    ).statusCode,
    409,
  )
  assert.equal(
    (
      await api.inject({
        method: 'POST',
        url: '/v1/vault/deposits',
        payload: pending,
        headers: { 'openpassword-protocol-version': '1' },
      })
    ).statusCode,
    409,
  )
  await request(begin + '/' + migrated.generation + '/commit', { check: migrated.check })
  const valid = migrated.items[0]
  await request(vault + '/items', {
    id: valid.id,
    revision: valid.revision,
    value: valid.value,
    generation: migrated.generation,
  })
})

test('committing a vault upgrade needs a passkey approval once a passkey is enrolled', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'private-upgrade-passkey-')),
    api = service(dir)
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const login = await api.inject({
    url: '/admin/login',
    method: 'POST',
    payload: { token: readFileSync(join(dir, 'operator.token'), 'utf8') },
  })
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] }
  const call = (url: string, payload?: object) =>
    api.inject({ url, method: payload ? 'POST' : 'GET', payload, headers })
  const key = await importVaultKey(newVaultKey())
  const { tenant, profile } = (await call('/profile/vault')).json()
  const check = await encryptPrivate(
    key,
    JSON.stringify(['OpenPassword.private.v1', tenant, profile, 'unlock']),
    'OpenPassword private vault',
  )
  assert.equal((await call('/profile/vault', { check })).statusCode, 200)
  const attempt = (await call('/profile/vault/upgrade', {})).json().id
  // An enrolled credential is enough to require approval; no authenticator ceremony is needed to see the refusal.
  const db = new DatabaseSync(join(dir, 'vault.sqlite'))
  db.prepare('INSERT INTO passkeys VALUES(?,?,?,?,?,?)').run(
    'ZmFrZS1jcmVkZW50aWFs',
    'owner',
    'handle',
    new Uint8Array(1),
    0,
    'fixture',
  )
  db.close()
  const refused = await call('/profile/vault/upgrade/' + attempt + '/commit', { check })
  assert.equal(refused.statusCode, 428)
  assert.ok(refused.json().approval.id)
  assert.equal((await call('/profile/vault')).json().check, check)
})

test('every high-impact console change needs approval once a passkey is enrolled', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'passkey-coverage-')),
    api = service(dir)
  t.after(async () => {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const login = await api.inject({
    url: '/admin/login',
    method: 'POST',
    payload: { token: readFileSync(join(dir, 'operator.token'), 'utf8') },
  })
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] }
  const db = new DatabaseSync(join(dir, 'vault.sqlite'))
  db.prepare('INSERT INTO passkeys VALUES(?,?,?,?,?,?)').run(
    'ZmFrZS1jcmVkZW50aWFs',
    'owner',
    'handle',
    new Uint8Array(1),
    0,
    'fixture',
  )
  db.close()
  // The refusal comes before validation and lookup, so placeholder identifiers and empty bodies are enough.
  for (const [method, url] of [
    ['POST', '/admin/apps'],
    ['POST', '/admin/apps/x'],
    ['POST', '/admin/delegation/signing-key/rotate'],
    ['DELETE', '/admin/delegation/grants/x'],
    ['DELETE', '/admin/connections/x'],
    ['POST', '/admin/connections/x/oauth-refresh'],
    ['POST', '/admin/oauth/google'],
    ['DELETE', '/admin/grants/x'],
    ['DELETE', '/admin/hosts/x'],
    ['DELETE', '/admin/members/x'],
    ['DELETE', '/admin/items/x'],
    ['POST', '/admin/webhooks'],
    ['POST', '/admin/dispatch'],
    ['DELETE', '/profile/vault/items/x'],
  ] as const) {
    const response = await api.inject({ method, url, headers, payload: {} })
    assert.equal(response.statusCode, 428, method + ' ' + url)
  }
  assert.deepEqual(
    [...approvalExempt].sort(),
    [
      '/admin/intake',
      '/admin/login',
      '/admin/logout',
      '/admin/switch',
      '/profile/passkeys/approve',
      '/profile/passkeys/finish',
      '/profile/vault',
      '/profile/vault/deposits',
      '/profile/vault/items',
      '/profile/vault/upgrade',
      '/profile/vault/upgrade/:id/item',
    ],
  )
})
