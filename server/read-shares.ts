import { type DatabaseSync } from 'node:sqlite'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
export function readShares(
  api: FastifyInstance,
  db: DatabaseSync,
  who: (r: FastifyRequest) => [string, string],
  event: (t: string, a: string, id: string) => void,
) {
  const sealed = z
    .string()
    .min(38)
    .max(100000)
    .regex(/^[A-Za-z0-9_-]+$/)
  const base64 = z
    .string()
    .min(64)
    .max(1200)
    .regex(/^[A-Za-z0-9+/]+=*$/)
  const unavailable = () =>
    Object.assign(Error('Read share unavailable or changed'), { statusCode: 409 })
  db.exec(`CREATE TABLE IF NOT EXISTS read_identities(tenant TEXT,profile TEXT,pub TEXT,sealed TEXT,PRIMARY KEY(tenant,profile));
  CREATE TABLE IF NOT EXISTS read_shares(id TEXT PRIMARY KEY,tenant TEXT,owner TEXT,recipient TEXT,item TEXT,revision INTEGER,expires INTEGER,wrapped TEXT,value TEXT);
  CREATE INDEX IF NOT EXISTS read_recipient ON read_shares(tenant,recipient,id);
  CREATE INDEX IF NOT EXISTS read_owner ON read_shares(tenant,owner,item);
  CREATE INDEX IF NOT EXISTS read_expiry ON read_shares(expires);
  CREATE TRIGGER IF NOT EXISTS remove_stale_read AFTER UPDATE ON personal_items BEGIN DELETE FROM read_shares WHERE tenant=OLD.tenant AND owner=OLD.profile AND item=OLD.id; END;
  CREATE TRIGGER IF NOT EXISTS remove_deleted_read AFTER DELETE ON personal_items BEGIN DELETE FROM read_shares WHERE tenant=OLD.tenant AND owner=OLD.profile AND item=OLD.id; END;`)
  const root = '/profile/vault/read'
  api.get(
    root + '/identity',
    async (r) =>
      db
        .prepare('SELECT pub,sealed FROM read_identities WHERE tenant=? AND profile=?')
        .get(...who(r)) ?? {},
  )
  api.post(root + '/identity', async (r) => {
    const [t, p] = who(r),
      { pub, sealed: priv } = z.object({ pub: base64, sealed }).strict().parse(r.body)
    if (
      !db
        .prepare(
          'INSERT OR IGNORE INTO read_identities SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM private_formats WHERE tenant=? AND profile=?)',
        )
        .run(t, p, pub, priv, t, p).changes
    )
      throw unavailable()
    return { ok: true }
  })
  api.get(root + '/recipient/:profile', async (r) => {
    const [t] = who(r),
      { profile } = z.object({ profile: z.string().max(200) }).parse(r.params)
    return (
      db.prepare('SELECT pub FROM read_identities WHERE tenant=? AND profile=?').get(t, profile) ??
      {}
    )
  })
  const shareSchema = z
    .object({
      id: z.uuid(),
      item: z.uuid(),
      recipient: z.string().min(1).max(200),
      revision: z.number().int().positive(),
      expires: z.number().int().safe(),
      pub: base64,
      wrapped: base64,
      value: sealed,
    })
    .strict()

  function insert(t: string, p: string, b: z.infer<typeof shareSchema>) {
    if (b.expires <= Date.now() || b.expires > Date.now() + 365 * 86400000 || b.recipient === p)
      throw unavailable()
    if (
      !db
        .prepare(
          `INSERT OR IGNORE INTO read_shares SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM personal_items WHERE tenant=? AND profile=? AND id=? AND revision=?) AND EXISTS(SELECT 1 FROM read_identities WHERE tenant=? AND profile=? AND pub=?)`,
        )
        .run(
          b.id,
          t,
          p,
          b.recipient,
          b.item,
          b.revision,
          b.expires,
          b.wrapped,
          b.value,
          t,
          p,
          b.item,
          b.revision,
          t,
          b.recipient,
          b.pub,
        ).changes
    )
      throw unavailable()
  }
  function transaction<T>(fn: () => T) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const v = fn()
      db.exec('COMMIT')
      return v
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  api.post(root, async (r) => {
    const [t, p] = who(r),
      b = shareSchema.parse(r.body)
    return transaction(() => {
      db.prepare('DELETE FROM read_shares WHERE expires<=?').run(Date.now())
      insert(t, p, b)
      event(t, 'Private item read access shared', b.id)
      return { ok: true }
    })
  })
  db.exec(`CREATE TABLE IF NOT EXISTS private_read_groups(id TEXT PRIMARY KEY,tenant TEXT,owner TEXT,version INTEGER,roster TEXT,description TEXT);
    CREATE INDEX IF NOT EXISTS private_group_owner ON private_read_groups(tenant,owner);
    CREATE TABLE IF NOT EXISTS group_deliveries(id TEXT PRIMARY KEY,group_id TEXT);
    CREATE INDEX IF NOT EXISTS group_deliveries_group ON group_deliveries(group_id);
    CREATE TRIGGER IF NOT EXISTS cleanup_group_delivery AFTER DELETE ON read_shares BEGIN DELETE FROM group_deliveries WHERE id=OLD.id; END;`)
  const groups = root + '/groups'
  const member = z.string().min(1).max(200)
  const owned = (t: string, p: string, id: string) =>
    db
      .prepare('SELECT * FROM private_read_groups WHERE tenant=? AND owner=? AND id=?')
      .get(t, p, id)
  const purge = (id: string) =>
    db
      .prepare(
        'DELETE FROM read_shares WHERE id IN (SELECT id FROM group_deliveries WHERE group_id=?)',
      )
      .run(id)
  api.get(groups, async (r) =>
    db
      .prepare(
        'SELECT id,version,description FROM private_read_groups WHERE tenant=? AND owner=? ORDER BY id',
      )
      .all(...who(r)),
  )
  api.post(groups, async (r) => {
    const [t, p] = who(r),
      b = z
        .object({
          id: z.uuid(),
          version: z.number().int().nonnegative(),
          roster: z.array(member).min(1).max(16),
          description: sealed,
        })
        .strict()
        .parse(r.body)
    if (new Set(b.roster).size !== b.roster.length || b.roster.includes(p)) throw unavailable()
    return transaction(() => {
      for (const recipient of b.roster)
        if (
          !db
            .prepare('SELECT 1 FROM read_identities WHERE tenant=? AND profile=?')
            .get(t, recipient)
        )
          throw unavailable()
      const roster = JSON.stringify([...b.roster].sort())
      if (b.version === 0) {
        if (
          !db
            .prepare(
              'INSERT OR IGNORE INTO private_read_groups SELECT ?,?,?,1,?,? WHERE (SELECT count(*) FROM private_read_groups WHERE tenant=? AND owner=?)<64',
            )
            .run(b.id, t, p, roster, b.description, t, p).changes
        )
          throw unavailable()
      } else {
        if (
          !db
            .prepare(
              'UPDATE private_read_groups SET roster=?,description=?,version=version+1 WHERE tenant=? AND owner=? AND id=? AND version=?',
            )
            .run(roster, b.description, t, p, b.id, b.version).changes
        )
          throw unavailable()
        purge(b.id)
      }
      event(t, 'Private read group saved', b.id)
      return { ok: true }
    })
  })
  api.delete(groups + '/:id', async (r) => {
    const [t, p] = who(r),
      { id } = z.object({ id: z.uuid() }).parse(r.params)
    return transaction(() => {
      if (!owned(t, p, id)) throw unavailable()
      purge(id)
      db.prepare('DELETE FROM private_read_groups WHERE id=?').run(id)
      event(t, 'Private read group removed', id)
      return { ok: true }
    })
  })
  api.post(groups + '/:id/share', { bodyLimit: 1200000 }, async (r) => {
    const [t, p] = who(r),
      { id } = z.object({ id: z.uuid() }).parse(r.params),
      b = z
        .object({
          version: z.number().int().positive(),
          copies: z.array(shareSchema).min(1).max(16),
        })
        .strict()
        .parse(r.body)
    return transaction(() => {
      const group = owned(t, p, id),
        first = b.copies[0]
      if (
        !group ||
        group.version !== b.version ||
        group.roster !== JSON.stringify(b.copies.map((c) => c.recipient).sort()) ||
        b.copies.some(
          (c) =>
            c.item !== first.item || c.revision !== first.revision || c.expires !== first.expires,
        )
      )
        throw unavailable()
      db.prepare('DELETE FROM read_shares WHERE expires<=?').run(Date.now())
      for (const c of b.copies) {
        insert(t, p, c)
        db.prepare('INSERT INTO group_deliveries VALUES(?,?)').run(c.id, id)
      }
      event(t, 'Private item shared with read group', id)
      return { ok: true }
    })
  })
  api.get(root, async (r) => {
    const [t, p] = who(r),
      { after } = z.object({ after: z.uuid().optional() }).parse(r.query)
    const rows = db
      .prepare(
        'SELECT id,item,revision,owner,recipient,expires FROM read_shares WHERE tenant=? AND (recipient=? OR owner=?) AND expires>? AND id>? ORDER BY id LIMIT 51',
      )
      .all(t, p, p, Date.now(), after ?? '')
    return { rows: rows.slice(0, 50), next: rows.length > 50 ? rows[49].id : null }
  })
  api.get(root + '/:id', async (r) => {
    const [t, p] = who(r),
      { id } = z.object({ id: z.uuid() }).parse(r.params)
    const row = db
      .prepare('SELECT * FROM read_shares WHERE id=? AND tenant=? AND recipient=? AND expires>?')
      .get(id, t, p, Date.now())
    if (!row) throw unavailable()
    return row
  })
  api.delete(root + '/:id', async (r) => {
    const [t, p] = who(r),
      { id } = z.object({ id: z.uuid() }).parse(r.params)
    if (
      !db.prepare('DELETE FROM read_shares WHERE tenant=? AND owner=? AND id=?').run(t, p, id)
        .changes
    )
      throw unavailable()
    event(t, 'Private item read access revoked', id)
    return { ok: true }
  })
}
