import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

type Principal = { tenant: string; member: string | null; token: string }
export function privateMigration(
  api: FastifyInstance,
  db: DatabaseSync,
  session: (r: FastifyRequest) => Principal,
  event: (tenant: string, action: string, id: string) => void,
  ciphertext: z.ZodString,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS private_generations(tenant TEXT,profile TEXT,id TEXT NOT NULL,PRIMARY KEY(tenant,profile));
    CREATE TABLE IF NOT EXISTS private_migrations(id TEXT PRIMARY KEY,tenant TEXT,profile TEXT,session TEXT,expires INTEGER,dirty INTEGER DEFAULT 0,UNIQUE(tenant,profile));
    CREATE TABLE IF NOT EXISTS private_staged(migration TEXT,item TEXT,value TEXT NOT NULL,PRIMARY KEY(migration,item));
    CREATE TRIGGER IF NOT EXISTS private_stage_cleanup AFTER DELETE ON private_migrations BEGIN
      DELETE FROM private_staged WHERE migration=OLD.id;
    END;
  `)
  for (const change of ['INSERT', 'UPDATE', 'DELETE']) {
    const row = change === 'DELETE' ? 'OLD' : 'NEW'
    db.exec(`CREATE TRIGGER IF NOT EXISTS private_changed_${change} AFTER ${change} ON personal_items BEGIN
      UPDATE private_migrations SET dirty=1 WHERE tenant=${row}.tenant AND profile=${row}.profile AND dirty=0;
    END;`)
  }
  const discardExpired = () =>
    db.prepare('DELETE FROM private_migrations WHERE expires<=?').run(Date.now())
  discardExpired()
  const timer = setInterval(discardExpired, 600000)
  timer.unref()
  api.addHook('onClose', async () => {
    clearInterval(timer)
  })
  function conflict(): never {
    throw Object.assign(Error('Vault changed or upgrade expired. Lock, unlock and try again.'), {
      statusCode: 409,
    })
  }
  function transaction<T>(fn: () => T) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      db.exec('COMMIT')
      return value
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  const owner = (s: Principal) => [s.tenant, s.member || 'owner']
  const generation = (tenant: string, profile: string) =>
    db
      .prepare('SELECT id FROM private_generations WHERE tenant=? AND profile=?')
      .get(tenant, profile)?.id
  api.post('/profile/vault/upgrade', async (r) => {
    const s = session(r),
      scope = owner(s)
    return transaction(() => {
      if (
        !db.prepare('SELECT 1 FROM personal_vaults WHERE tenant=? AND profile=?').get(...scope) ||
        db.prepare('SELECT 1 FROM private_formats WHERE tenant=? AND profile=?').get(...scope)
      )
        conflict()
      db.prepare('DELETE FROM private_migrations WHERE expires<=? OR (tenant=? AND profile=?)').run(
        Date.now(),
        ...scope,
      )
      const id = randomUUID()
      db.prepare(
        'INSERT INTO private_migrations(id,tenant,profile,session,expires) VALUES(?,?,?,?,?)',
      ).run(id, ...scope, s.token, Date.now() + 3600000)
      return { id }
    })
  })
  function active(s: Principal, id: string) {
    if (
      !db
        .prepare(
          'SELECT 1 FROM private_migrations WHERE id=? AND tenant=? AND profile=? AND session=? AND expires>? AND dirty=0',
        )
        .get(id, ...owner(s), s.token, Date.now())
    )
      conflict()
  }
  const migrationId = (r: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(r.params).id
  api.post('/profile/vault/upgrade/:id/item', async (r) => {
    const s = session(r),
      id = migrationId(r)
    const b = z
      .object({ id: z.string().uuid(), revision: z.number().int().positive(), value: ciphertext })
      .strict()
      .parse(r.body)
    return transaction(() => {
      active(s, id)
      if (
        !db
          .prepare(
            'SELECT 1 FROM personal_items WHERE id=? AND tenant=? AND profile=? AND revision=?',
          )
          .get(b.id, ...owner(s), b.revision)
      )
        conflict()
      db.prepare(
        'INSERT INTO private_staged VALUES(?,?,?) ON CONFLICT(migration,item) DO UPDATE SET value=excluded.value',
      ).run(id, b.id, b.value)
      return { ok: true }
    })
  })
  api.post('/profile/vault/upgrade/:id/commit', async (r) => {
    const s = session(r),
      scope = owner(s),
      id = migrationId(r)
    const { check } = z.object({ check: ciphertext }).strict().parse(r.body)
    return transaction(() => {
      if (generation(scope[0], scope[1]) === id) return { ok: true }
      active(s, id)
      if (
        db
          .prepare(
            `SELECT 1 FROM personal_items p WHERE tenant=? AND profile=? AND NOT EXISTS
        (SELECT 1 FROM private_staged x WHERE x.migration=? AND x.item=p.id) LIMIT 1`,
          )
          .get(...scope, id)
      )
        conflict()
      db.prepare(
        `UPDATE personal_items SET value=(SELECT value FROM private_staged WHERE migration=? AND item=personal_items.id),
        revision=revision+1 WHERE tenant=? AND profile=?`,
      ).run(id, ...scope)
      db.prepare('UPDATE personal_vaults SET check_value=? WHERE tenant=? AND profile=?').run(
        check,
        ...scope,
      )
      db.prepare('INSERT INTO private_formats VALUES(?,?,?)').run(
        ...scope,
        'PBKDF2-SHA256-600000-v1',
      )
      db.prepare('INSERT INTO private_generations VALUES(?,?,?)').run(...scope, id)
      db.prepare('DELETE FROM private_deposits WHERE tenant=? AND profile=?').run(...scope)
      db.prepare('DELETE FROM private_migrations WHERE id=?').run(id)
      event(s.tenant, 'Private vault upgraded', scope[1])
      return { ok: true }
    })
  })
  return {
    transaction,
    generation,
    check(tenant: string, profile: string, expected: unknown) {
      if (generation(tenant, profile) !== expected) conflict()
    },
  }
}
