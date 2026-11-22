import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { verifyLoopsWebhook, verifyTwilioWebhook } from '../packages/connectors/webhooks.ts'
type Row = Record<string, any>
export function inbound(
  api: FastifyInstance,
  db: DatabaseSync,
  origin: string,
  owner: (r: FastifyRequest) => string,
  intake: (r: FastifyRequest, f: string) => unknown,
  seal: (v: unknown, id: string) => string,
  open: (v: string, id: string) => any,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_sites(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,conn TEXT NOT NULL,provider TEXT NOT NULL,active INTEGER NOT NULL,secret TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS webhook_events(seq INTEGER PRIMARY KEY,site TEXT NOT NULL,message TEXT NOT NULL,digest TEXT NOT NULL,received INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(site,message));`)
  api.post('/admin/webhooks', async (r, reply) => {
    const tenant = owner(r),
      b = z
        .object({ connection_id: z.string(), secret: z.string().min(1).max(4096) })
        .strict()
        .parse(intake(r, 'secret'))
    const c = db
      .prepare('SELECT provider FROM connections WHERE id=? AND tenant=? AND active=1')
      .get(b.connection_id, tenant)
    if (!c || !['loops', 'twilio'].includes(String(c.provider)))
      return reply.code(422).send({ detail: 'Select an active Loops or Twilio connection' })
    const id = randomUUID()
    db.prepare('INSERT INTO webhook_sites VALUES(?,?,?,?,1,?)').run(
      id,
      tenant,
      b.connection_id,
      c.provider,
      seal(b.secret, id),
    )
    return { id, url: origin + '/hooks/' + id }
  })
  api.delete('/admin/webhooks/:id', async (r, reply) => {
    const tenant = owner(r),
      { id } = r.params as { id: string }
    if (
      !db
        .prepare("UPDATE webhook_sites SET active=0,secret='' WHERE tenant=? AND id=? AND active=1")
        .run(tenant, id).changes
    )
      return reply.code(404).send({ detail: 'Webhook unavailable' })
    return reply.code(204).send()
  })
  api.get('/admin/webhooks/:id/events', async (r, reply) => {
    const tenant = owner(r),
      { id } = r.params as { id: string },
      q = z
        .object({
          after: z.coerce.number().int().nonnegative().default(0),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .strict()
        .parse(r.query)
    if (!db.prepare('SELECT id FROM webhook_sites WHERE tenant=? AND id=?').get(tenant, id))
      return reply.code(404).send({ detail: 'Webhook unavailable' })
    return db
      .prepare(
        'SELECT seq,message,digest,received,payload FROM webhook_events WHERE site=? AND seq>? ORDER BY seq LIMIT ?',
      )
      .all(id, q.after, q.limit)
      .map((e) => ({ ...e, payload: open(String(e.payload), id + '/' + e.message) }))
  })
  api.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser(
      ['application/json', 'application/x-www-form-urlencoded'],
      { parseAs: 'buffer' },
      (_r, b, done) => done(null, b),
    )
    scope.post('/hooks/:id', { bodyLimit: 1048576 }, async (r, reply) => {
      const { id } = r.params as { id: string },
        row = db
          .prepare(
            "SELECT w.* FROM webhook_sites w JOIN connections c ON c.id=w.conn AND c.tenant=w.tenant WHERE w.id=? AND w.active=1 AND c.active=1 AND NOT EXISTS(SELECT 1 FROM credential_deadlines d WHERE d.conn=c.id AND d.target='credential' AND d.expires<=?)",
          )
          .get(id, Date.now()) as Row | undefined
      if (!row) return reply.code(404).send()
      const bytes = r.body as Buffer,
        key = open(row.secret, id)
      let message: string, payload: unknown
      try {
        if (row.provider === 'loops') {
          message = verifyLoopsWebhook(
            bytes,
            {
              id: String(r.headers['webhook-id'] ?? ''),
              timestamp: String(r.headers['webhook-timestamp'] ?? ''),
              signature: String(r.headers['webhook-signature'] ?? ''),
            },
            [key],
          ).webhook_id
          payload = JSON.parse(bytes.toString())
        } else {
          const form = new URLSearchParams(bytes.toString())
          if (
            !verifyTwilioWebhook(
              origin + r.raw.url,
              form,
              String(r.headers['x-twilio-signature'] ?? ''),
              key,
            )
          )
            throw Error()
          const sid = form.get('MessageSid'),
            state = form.get('MessageStatus') ?? 'inbound'
          if (!sid || !/^SM[0-9a-fA-F]{32}$/.test(sid) || !/^[a-z-]{1,40}$/.test(state))
            throw Error()
          message = sid + '/' + state
          payload = Object.fromEntries(form)
        }
      } catch {
        return reply.code(403).send({ detail: 'Webhook refused' })
      }
      const hash = createHash('sha256').update(bytes).digest('hex')
      const prev = db
        .prepare('SELECT digest FROM webhook_events WHERE site=? AND message=?')
        .get(id, message)
      if (prev && prev.digest !== hash)
        return reply.code(409).send({ detail: 'Delivery changed under its identifier' })
      if (!prev)
        db.prepare(
          'INSERT INTO webhook_events(site,message,digest,received,payload) VALUES(?,?,?,?,?)',
        ).run(id, message, hash, Date.now(), seal(payload, id + '/' + message))
      return reply.code(204).send()
    })
  })
}
