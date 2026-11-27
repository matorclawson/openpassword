import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { readShares } from '../server/read-shares.ts'
import {
  identityContext,
  sharingIdentity,
  fingerprint,
  sealCopy,
  openCopy,
} from '../app/read-share-crypto.ts'
import { importVaultKey, newVaultKey } from '../app/private-crypto.ts'
import { wrapVaultKey, unwrapVaultKey } from '../app/vault-custody.ts'
test('human read shares bind identities and revision, isolate tenants and stop delivery after revocation, expiry or edit', async (t) => {
  const api = Fastify(),
    db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE private_formats(tenant TEXT,profile TEXT);CREATE TABLE personal_items(tenant TEXT,profile TEXT,id TEXT,revision INTEGER);',
  )
  readShares(
    api,
    db,
    (r) => [String(r.headers.tenant), String(r.headers.profile)],
    () => {},
  )
  t.after(async () => {
    await api.close()
    db.close()
  })
  const req = async (
    profile: string,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: object,
    tenant = 'org',
  ) =>
    api.inject({
      method,
      url: '/profile/vault/read' + path,
      headers: { profile, tenant },
      payload: body,
    })
  const id = randomUUID()
  db.prepare('INSERT INTO personal_items VALUES(?,?,?,1)').run('org', 'joe', id)
  db.exec("INSERT INTO private_formats VALUES('org','jane')")
  const vault = await importVaultKey(newVaultKey()),
    identity = await sharingIdentity(vault, identityContext('org', 'jane'))
  assert.equal((await req('jane', 'POST', '/identity', identity)).statusCode, 200)
  assert.equal((await req('joe', 'GET', '/recipient/jane')).json().sealed, undefined)
  assert.deepEqual((await req('joe', 'GET', '/identity')).json(), {})
  const b = {
    tenant: 'org',
    owner: 'joe',
    recipient: 'jane',
    item: id,
    revision: 1,
    id: randomUUID(),
    expires: Date.now() + 60000,
  }
  const fp = await fingerprint(identity.pub)
  await assert.rejects(sealCopy(identity.pub, 'wrong', b, 'Title', 'private'))
  const enc = await sealCopy(identity.pub, fp, b, 'Title', 'private')
  const share = async () =>
    req('joe', 'POST', '', {
      id: b.id,
      recipient: b.recipient,
      item: id,
      revision: 1,
      expires: b.expires,
      pub: identity.pub,
      ...enc,
    })
  assert.equal((await share()).statusCode, 200)
  assert.equal((await req('joe', 'GET', '/' + b.id)).statusCode, 409)
  assert.equal((await req('jane', 'GET', '/' + b.id, undefined, 'other')).statusCode, 409)
  const copy = (await req('jane', 'GET', '/' + b.id)).json()
  assert.deepEqual(await openCopy(vault, identity.sealed, copy, copy.wrapped, copy.value), {
    title: 'Title',
    secret: 'private',
  })
  await assert.rejects(
    openCopy(vault, identity.sealed, { ...b, revision: 2 }, enc.wrapped, enc.value),
  )
  assert.equal((await req('jane', 'DELETE', '/' + b.id)).statusCode, 409)
  assert.equal((await req('joe', 'DELETE', '/' + b.id)).statusCode, 200)
  assert.equal((await req('jane', 'GET', '/' + b.id)).statusCode, 409)
  assert.equal((await share()).statusCode, 200)
  db.exec('UPDATE read_shares SET expires=1')
  assert.equal((await req('jane', 'GET', '/' + b.id)).statusCode, 409)
  assert.equal((await share()).statusCode, 200)
  const secondVault = await importVaultKey(newVaultKey()),
    other = await sharingIdentity(secondVault, identityContext('org', 'alex'))
  db.exec("INSERT INTO private_formats VALUES('org','alex')")
  await req('alex', 'POST', '/identity', other)
  const gid = randomUUID(),
    roster = { id: gid, version: 0, roster: ['jane', 'alex'], description: identity.sealed }
  assert.equal((await req('joe', 'POST', '/groups', roster)).statusCode, 200)
  const groupCopies: Array<{
    item: string
    recipient: string
    pub: string
    revision: number
    id: string
    expires: number
    wrapped: string
    value: string
  }> = []
  for (const [recipient, pub] of [
    ['jane', identity.pub],
    ['alex', other.pub],
  ]) {
    const binding = { ...b, id: randomUUID(), recipient },
      cipher = await sealCopy(pub, await fingerprint(pub), binding, 'Title', 'private')
    groupCopies.push({
      item: id,
      recipient,
      pub,
      revision: 1,
      id: binding.id,
      expires: b.expires,
      ...cipher,
    })
  }
  const sendGroup = (copies: typeof groupCopies) =>
    req('joe', 'POST', '/groups/' + gid + '/share', { version: 1, copies })
  assert.equal((await sendGroup([groupCopies[0]])).statusCode, 409)
  assert.equal(
    (await sendGroup([groupCopies[0], { ...groupCopies[1], pub: identity.pub }])).statusCode,
    409,
  )
  assert.equal((await req('jane', 'GET', '/' + groupCopies[0].id)).statusCode, 409)
  assert.equal((await sendGroup(groupCopies)).statusCode, 200)
  const forAlex = (await req('alex', 'GET', '/' + groupCopies[1].id)).json()
  assert.equal(
    (await openCopy(secondVault, other.sealed, forAlex, forAlex.wrapped, forAlex.value)).secret,
    'private',
  )
  assert.equal(
    (await req('joe', 'POST', '/groups', { ...roster, version: 1, roster: ['jane'] })).statusCode,
    200,
  )
  assert.equal((await req('alex', 'GET', '/' + groupCopies[1].id)).statusCode, 409)
  assert.equal((await sendGroup(groupCopies)).statusCode, 409)
  assert.equal((await req('jane', 'GET', '/' + b.id)).statusCode, 200)
  db.exec('UPDATE personal_items SET revision=2')
  assert.equal((await req('jane', 'GET', '/' + b.id)).statusCode, 409)
})
test('recovery kit needs the matching code and original vault context', async () => {
  const k = await importVaultKey(newVaultKey()),
    f = newVaultKey()
  const box = await wrapVaultKey(k, 'owner/vault', f)
  const { encryptPrivate, decryptPrivate } = await import('../app/private-crypto.ts')
  const value = await encryptPrivate(await importVaultKey(f), 'field', 'synthetic')
  assert.equal(
    await decryptPrivate(await unwrapVaultKey(k, 'owner/vault', box), 'field', value),
    'synthetic',
  )
  assert.ok(!box.includes(f))
  await assert.rejects(unwrapVaultKey(k, 'other/vault', box))
  await assert.rejects(unwrapVaultKey(await importVaultKey(newVaultKey()), 'owner/vault', box))
})
test('a designated recovery custodian opens only the code envelope in its original context', async () => {
  const { openRecoveryCode, sealRecoveryCode } = await import('../app/read-share-crypto.ts')
  const vault = await importVaultKey(newVaultKey()),
    ctx = identityContext('org', 'jane')
  const { pub, sealed } = await sharingIdentity(vault, ctx),
    code = newVaultKey()
  const wrap = await sealRecoveryCode(pub, await fingerprint(pub), 'kit one', code)
  assert.equal(await openRecoveryCode(vault, sealed, ctx, 'kit one', wrap), code)
  await assert.rejects(openRecoveryCode(vault, sealed, ctx, 'kit two', wrap))
  await assert.rejects(
    openRecoveryCode(await importVaultKey(newVaultKey()), sealed, ctx, 'kit one', wrap),
  )
})
