import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
type Principal = { tenant: string; member: string | null }
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
  function who(r: FastifyRequest): [string, string] {
    const s = session(r)
    return [s.tenant, s.member || 'owner']
  }
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
    const items = rows
      .slice(0, 25)
      .map((i) => ({
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
      { check } = z.object({ check: ciphertext }).strict().parse(r.body)
    if (!db.prepare('INSERT OR IGNORE INTO personal_vaults VALUES(?,?,?)').run(t, p, check).changes)
      throw missing()
    event(t, 'Private vault created', p)
    return { ok: true }
  })
  api.post('/profile/vault/items', async (r) => {
    const [t, p] = who(r),
      b = z
        .object({
          id: z.string().uuid(),
          value: ciphertext,
          revision: z.number().int().nonnegative(),
        })
        .strict()
        .parse(r.body)
    if (!db.prepare('SELECT 1 FROM personal_vaults WHERE tenant=? AND profile=?').get(t, p))
      throw missing()
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
  api.delete('/profile/vault/items/:id', async (r) => {
    const [t, p] = who(r),
      { id } = z.object({ id: z.string().uuid() }).parse(r.params)
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
}
