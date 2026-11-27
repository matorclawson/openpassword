// Synthetic fixture called by the isolated backup rehearsal. No production configuration.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { service } from '../server/service.ts'
import {
  deriveCustodyMaterial,
  derivePrivateKey,
  newVaultKey,
  importVaultKey,
  encryptPrivate,
  decryptPrivate,
  privateScheme,
  sealPrivateItem,
  openPrivateValue,
} from '../app/private-crypto.ts'
import { wrapVaultKey, unwrapVaultKey } from '../app/vault-custody.ts'
const [mode, dir, fixture] = process.argv.slice(2)
const origin = 'https://synthetic-recovery.example'
const api = service(dir, origin)
try {
  const session = await api.inject({
    method: 'POST',
    url: '/admin/login',
    payload: { token: readFileSync(join(dir, 'operator.token'), 'utf8') },
  })
  const cookie = String(session.headers['set-cookie']).split(';')[0]
  const post = async (url: string, payload: object) => {
    const r = await api.inject({ method: 'POST', url, headers: { cookie }, payload })
    assert.equal(r.statusCode, 200)
  }
  const page = (await api.inject({ url: '/profile/vault', headers: { cookie } })).json()
  const ctx = (id: string) =>
    JSON.stringify(['OpenPassword.private.v1', page.tenant, page.profile, id])
  const recovery = (check: string) =>
    JSON.stringify([
      'OpenPassword.custody.v1',
      origin,
      page.tenant,
      page.profile,
      check,
      'recovery',
    ])
  if (mode === 'seed') {
    const saved = newVaultKey(),
      pass = newVaultKey(),
      key = await derivePrivateKey(saved, pass, page.tenant, page.profile),
      id = crypto.randomUUID()
    const check = await encryptPrivate(key, ctx('unlock'), 'OpenPassword private vault')
    await post('/profile/vault', { check, scheme: privateScheme })
    const value = await sealPrivateItem(
      key,
      ctx(id),
      ctx('value/' + id),
      'Canary',
      'synthetic human value',
    )
    await post('/profile/vault/items', { id, revision: 0, value })
    const code = newVaultKey(),
      material = await deriveCustodyMaterial(saved, pass, page.tenant, page.profile)
    // The harness holds both test-only recovery parts outside the broker backup.
    writeFileSync(
      fixture,
      JSON.stringify({
        code,
        box: await wrapVaultKey(await importVaultKey(code), recovery(check), material),
      }),
      { mode: 0o600, flag: 'wx' },
    )
  } else {
    assert.equal(mode, 'verify')
    const kit = JSON.parse(readFileSync(fixture, 'utf8')),
      key = await unwrapVaultKey(await importVaultKey(kit.code), recovery(page.check), kit.box)
    const row = page.items[0],
      item = JSON.parse(await decryptPrivate(key, ctx(row.id), row.value))
    assert.equal(await openPrivateValue(key, ctx('value/' + row.id), item), 'synthetic human value')
  }
} finally {
  await api.close()
}
