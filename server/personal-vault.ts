import { vaultDevices } from './vault-devices.ts'
import { readShares } from './read-shares.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { privateMigration } from './private-migration.ts'
import { z } from 'zod'
import { digest, opaque } from './store.ts'
type Principal = { tenant: string; member: string | null; token: string }
const ciphertext = z
  .string()
  .min(38)
  .max(60000)
  .regex(/^[A-Za-z0-9_-]+$/)
export function personalVault(
  api: FastifyInstance,
  db: DatabaseSync,
  session: (r: FastifyRequest) => Principal,
  event: (t: string, a: string, id: string) => void,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS personal_vaults(tenant TEXT,profile TEXT,check_value TEXT NOT NULL,PRIMARY KEY(tenant,profile));
  CREATE TABLE IF NOT EXISTS personal_items(id TEXT PRIMARY KEY,tenant TEXT,profile TEXT,value TEXT NOT NULL,revision INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS personal_directory ON personal_items(tenant,profile,id);
  CREATE TABLE IF NOT EXISTS personal_delegations(conn TEXT PRIMARY KEY,item TEXT NOT NULL);`)
  db.exec(
    'CREATE TABLE IF NOT EXISTS private_formats(tenant TEXT, profile TEXT, scheme TEXT NOT NULL, PRIMARY KEY(tenant,profile))',
  )
  const upgrade = privateMigration(api, db, session, event, ciphertext)
  function who(r: FastifyRequest): [string, string] {
    const s = session(r)
    return [s.tenant, s.member || 'owner']
  }
  vaultDevices(api, db, who, event)
  readShares(api, db, who, event)
  const missing = () =>
    Object.assign(Error('Private item unavailable or changed'), { statusCode: 409 })
  api.get('/profile/vault', async (r) => {
    const [tenant, profile] = who(r)
    const after = z.object({ after: z.string().uuid().optional() }).parse(r.query).after || ''
    const rows = db
      .prepare(
        'SELECT id,value,revision FROM personal_items WHERE tenant=? AND profile=? AND id>? ORDER BY id LIMIT 26',
      )
      .all(tenant, profile, after)
    const items = rows.slice(0, 25).map((i) => ({
      ...i,
      connections: db
        .prepare(
          'SELECT c.id,c.label FROM personal_delegations d JOIN connections c ON c.id=d.conn WHERE d.item=? AND c.tenant=? AND c.active=1',
        )
        .all(i.id, tenant),
    }))
    return {
      tenant,
      profile,
      generation: upgrade.generation(tenant, profile),
      scheme:
        db
          .prepare('SELECT scheme FROM private_formats WHERE tenant=? AND profile=?')
          .get(tenant, profile)?.scheme ?? 'raw-v1',
      check:
        db
          .prepare('SELECT check_value FROM personal_vaults WHERE tenant=? AND profile=?')
          .get(tenant, profile)?.check_value ?? null,
      items,
      next: rows.length > 25 ? rows[24].id : null,
    }
  })
  api.post('/profile/vault', async (r) => {
    const [t, p] = who(r),
      { check, scheme } = z
        .object({ check: ciphertext, scheme: z.literal('PBKDF2-SHA256-600000-v1').optional() })
        .strict()
        .parse(r.body)
    db.exec('BEGIN IMMEDIATE')
    try {
      if (
        !db.prepare('INSERT OR IGNORE INTO personal_vaults VALUES(?,?,?)').run(t, p, check).changes
      )
        throw missing()
      if (scheme) db.prepare('INSERT INTO private_formats VALUES(?,?,?)').run(t, p, scheme)
      event(t, 'Private vault created', p)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return { ok: true }
  })
  api.post('/profile/vault/items', async (r) => {
    const [t, p] = who(r),
      b = z
        .object({
          id: z.string().uuid(),
          value: ciphertext,
          generation: z.string().uuid().optional(),
          revision: z.number().int().nonnegative(),
        })
        .strict()
        .parse(r.body)
    if (!db.prepare('SELECT 1 FROM personal_vaults WHERE tenant=? AND profile=?').get(t, p))
      throw missing()
    return upgrade.transaction(() => {
      upgrade.check(t, p, b.generation)
      const result =
        b.revision === 0
          ? db
              .prepare('INSERT OR IGNORE INTO personal_items VALUES(?,?,?,?,1)')
              .run(b.id, t, p, b.value)
          : db
              .prepare(
                'UPDATE personal_items SET value=?,revision=revision+1 WHERE id=? AND tenant=? AND profile=? AND revision=?',
              )
              .run(b.value, b.id, t, p, b.revision)
      if (!result.changes) throw missing()
      event(t, 'Private item saved', b.id)
      return { ok: true }
    })
  })
  db.exec(`CREATE TABLE IF NOT EXISTS private_deposits(ticket TEXT PRIMARY KEY,tenant TEXT,profile TEXT,session TEXT,item TEXT,value TEXT,expires INTEGER);
    CREATE INDEX IF NOT EXISTS private_deposit_expiry ON private_deposits(expires)`)
  api.post('/profile/vault/deposits', async (r) => {
    const s = session(r),
      profile = s.member || 'owner'
    const b = z
      .object({
        id: z.string().uuid(),
        value: ciphertext,
        generation: z.string().uuid().optional(),
      })
      .strict()
      .parse(r.body)
    return upgrade.transaction(() => {
      upgrade.check(s.tenant, profile, b.generation)
      if (
        !db
          .prepare('SELECT 1 FROM personal_vaults WHERE tenant=? AND profile=?')
          .get(s.tenant, profile)
      )
        throw missing()
      const ticket = opaque()
      db.prepare('DELETE FROM private_deposits WHERE expires<=?').run(Date.now())
      db.prepare('INSERT INTO private_deposits VALUES(?,?,?,?,?,?,?)').run(
        digest(ticket),
        s.tenant,
        profile,
        s.token,
        b.id,
        b.value,
        Date.now() + 300000,
      )
      return { ticket }
    })
  })
  api.post('/v1/vault/deposits', async (r) => {
    const { ticket } = z
      .object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .parse(r.body)
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db
        .prepare(
          `DELETE FROM private_deposits WHERE ticket=? AND expires>?
        AND EXISTS(SELECT 1 FROM sessions s WHERE s.token=private_deposits.session AND s.tenant=private_deposits.tenant AND s.expires>?)
        AND (profile='owner' OR EXISTS(SELECT 1 FROM members m WHERE m.id=private_deposits.profile AND m.tenant=private_deposits.tenant AND m.active=1))
        RETURNING tenant,profile,item,value`,
        )
        .get(digest(ticket), Date.now(), Date.now())
      if (
        !row ||
        !db
          .prepare('INSERT OR IGNORE INTO personal_items VALUES(?,?,?,?,1)')
          .run(row.item, row.tenant, row.profile, row.value).changes
      )
        throw missing()
      event(String(row.tenant), 'Private item deposited', String(row.item))
      db.exec('COMMIT')
      return { saved: true }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
  api.delete('/profile/vault/items/:id', async (r) => {
    const [t, p] = who(r),
      { id } = z.object({ id: z.string().uuid() }).parse(r.params)
    return upgrade.transaction(() => {
      upgrade.check(
        t,
        p,
        z.object({ generation: z.string().uuid().optional() }).parse(r.query).generation,
      )
      if (
        !db
          .prepare(
            'DELETE FROM personal_items WHERE tenant=? AND profile=? AND id=? AND NOT EXISTS(SELECT 1 FROM personal_delegations d JOIN connections c ON c.id=d.conn WHERE d.item=? AND c.active=1)',
          )
          .run(t, p, id, id).changes
      )
        throw missing()
      event(t, 'Private item removed', id)
      return { ok: true }
    })
  })
}
