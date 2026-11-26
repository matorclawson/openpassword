import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
export function vaultDevices(
  api: FastifyInstance,
  db: DatabaseSync,
  who: (r: FastifyRequest) => [string, string],
  event: (t: string, a: string, id: string) => void,
) {
  const route = '/profile/vault/devices'
  db.exec(
    'CREATE TABLE IF NOT EXISTS vault_devices(id TEXT PRIMARY KEY,tenant TEXT,profile TEXT,label TEXT,expires INTEGER);CREATE INDEX IF NOT EXISTS vault_devices_owner ON vault_devices(tenant,profile,expires)',
  )
  api.get(route, async (r) =>
    db
      .prepare(
        'SELECT id,label,expires FROM vault_devices WHERE tenant=? AND profile=? AND expires>? ORDER BY expires',
      )
      .all(...who(r), Date.now()),
  )
  api.post(route, async (r) => {
    const [t, p] = who(r),
      { label } = z
        .object({ label: z.string().trim().min(1).max(80) })
        .strict()
        .parse(r.body),
      id = randomUUID(),
      expires = Date.now() + 30 * 86400000
    db.prepare('DELETE FROM vault_devices WHERE expires<=?').run(Date.now())
    const result = db
      .prepare(
        'INSERT INTO vault_devices SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM vault_devices WHERE tenant=? AND profile=?)<32 AND EXISTS(SELECT 1 FROM private_formats WHERE tenant=? AND profile=?)',
      )
      .run(id, t, p, label, expires, t, p, t, p)
    if (!result.changes)
      throw Object.assign(Error('Cannot enroll another device'), { statusCode: 409 })
    event(t, 'Private vault device enrolled', id)
    return { id, expires }
  })
  api.delete(route + '/:id', async (r) => {
    const [t, p] = who(r),
      { id } = z.object({ id: z.uuid() }).parse(r.params)
    if (
      !db.prepare('DELETE FROM vault_devices WHERE tenant=? AND profile=? AND id=?').run(t, p, id)
        .changes
    )
      throw Object.assign(Error('Unknown device'), { statusCode: 404 })
    event(t, 'Private vault device revoked', id)
    return { ok: true }
  })
}
