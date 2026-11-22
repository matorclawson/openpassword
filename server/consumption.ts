import { AsyncLocalStorage } from 'node:async_hooks'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

type Attribution = {
  tenant: string
  conn: string
  label: string
  provider: string
  revision: number
  profile: string
  seat: string
  seatLabel: string
  operation: string
  execution?: string
  model?: string
}
export function consumption(db: DatabaseSync, transport: typeof fetch) {
  db.exec(`CREATE TABLE IF NOT EXISTS consumption_events(
    id INTEGER PRIMARY KEY,started INTEGER NOT NULL,tenant TEXT NOT NULL,conn TEXT NOT NULL,label TEXT NOT NULL,
    provider TEXT NOT NULL,revision INTEGER NOT NULL,profile TEXT NOT NULL,seat TEXT NOT NULL,seat_label TEXT NOT NULL,
    operation TEXT NOT NULL,execution TEXT,model TEXT,status INTEGER,outcome TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER);
    CREATE INDEX IF NOT EXISTS consumption_window ON consumption_events(tenant,started);
    CREATE INDEX IF NOT EXISTS consumption_seat_window ON consumption_events(tenant,profile,started);
    CREATE UNIQUE INDEX IF NOT EXISTS consumption_execution ON consumption_events(execution) WHERE execution IS NOT NULL;`)
  const context = new AsyncLocalStorage<{ attribution?: Attribution }>()
  const insert = db.prepare(
    "INSERT INTO consumption_events(started,tenant,conn,label,provider,revision,profile,seat,seat_label,operation,execution,model,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'unresolved')",
  )
  const response = db.prepare('UPDATE consumption_events SET status=?,outcome=? WHERE id=?')
  const settle = db.prepare(
    'UPDATE consumption_events SET outcome=?,input_tokens=?,output_tokens=? WHERE execution=?',
  )
  const send: typeof fetch = async (input, init) => {
    const a = context.getStore()?.attribution
    if (!a) return transport(input, init)
    const id = insert.run(
      Date.now(),
      a.tenant,
      a.conn,
      a.label,
      a.provider,
      a.revision,
      a.profile,
      a.seat,
      a.seatLabel,
      a.operation,
      a.execution ?? null,
      a.model ?? null,
    ).lastInsertRowid
    try {
      const result = await transport(input, init)
      response.run(
        result.status,
        result.ok
          ? a.execution
            ? 'stream_or_body_pending'
            : 'response_received'
          : 'provider_error',
        id,
      )
      return result
    } catch (error) {
      response.run(null, 'transport_uncertain', id)
      throw error
    }
  }
  function report(tenant: string, profile: string, admin: boolean, query: unknown) {
    const q = z
      .object({
        group: z.enum(['credential', 'seat']).default('credential'),
        days: z.coerce.number().int().min(0).max(366).default(7),
        before: z.coerce.number().int().positive().optional(),
      })
      .parse(query)
    const where =
      "e.tenant=? AND e.started>=? AND (e.profile=? OR EXISTS(SELECT 1 FROM credential_ownership o WHERE o.conn=e.conn AND (o.owner=? OR (o.owner='org' AND ?=1))))"
    const args = [
      tenant,
      q.days ? Date.now() - q.days * 86400000 : 0,
      profile,
      profile,
      Number(admin),
    ]
    const from =
      ' FROM consumption_events e LEFT JOIN model_charges c ON c.execution=e.execution WHERE ' +
      where
    const dimension = q.group === 'seat' ? 'e.seat' : 'e.conn'
    const label = q.group === 'seat' ? 'e.seat_label' : 'e.label'
    const groups = db
      .prepare(
        'SELECT ' +
          dimension +
          ' AS id,e.conn,e.provider,MAX(' +
          label +
          ") AS label,COUNT(*) AS requests,SUM(COALESCE(c.charged,0)) AS priced_micro_usd,COUNT(c.charged) AS priced_requests,SUM(CASE WHEN c.state IN ('held','reserved') THEN c.reserved ELSE 0 END) AS pending_micro_usd,SUM(e.input_tokens) AS input_tokens,SUM(e.output_tokens) AS output_tokens" +
          from +
          ' GROUP BY ' +
          dimension +
          ',e.conn,e.provider ORDER BY priced_micro_usd DESC, requests DESC',
      )
      .all(...args)
    const events = db
      .prepare(
        'SELECT e.*,c.charged AS cost_micro_usd,c.state AS cost_state' +
          from +
          (q.before ? ' AND e.id<?' : '') +
          ' ORDER BY e.id DESC LIMIT 101',
      )
      .all(...args, ...(q.before ? [q.before] : []))
    return {
      groups,
      events: events.slice(0, 100),
      next: events.length > 100 ? events[99].id : null,
    }
  }
  return {
    send,
    report,
    scope: (next: () => void) => context.run({}, next),
    attribute(a: Attribution) {
      const ctx = context.getStore()
      if (ctx) ctx.attribution = a
    },
    finish(ex: string, state: string, raw: unknown) {
      const usage = z
        .object({
          prompt_tokens: z.number().int().nonnegative(),
          completion_tokens: z.number().int().nonnegative(),
        })
        .safeParse(raw)
      settle.run(
        state,
        usage.success ? usage.data.prompt_tokens : null,
        usage.success ? usage.data.completion_tokens : null,
        ex,
      )
    },
  }
}
