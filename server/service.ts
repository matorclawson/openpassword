import { scopedToken } from './provider-auth.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { intakeKeys, envelope } from './intake.ts'
import { batches } from './batches.ts'
import { sourceOperation, readSource, ReadFailure } from './read-source.ts'
import { project } from './projections.ts'
import { uploadRequest } from './youtube.ts'
import { gmailPage, GmailError } from './gmail.ts'
import { Readable } from 'node:stream'
import { modelLease, chat } from './models.ts'
import { authorize, exchange, oauthConfig } from './oauth.ts'
import Fastify, { type FastifyRequest } from 'fastify'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { buildRequest, providers, sheetsResult } from '../packages/connectors/index.ts'
import { connectionInput, invocation, name } from '../packages/schemas/index.ts'
import { store, digest, opaque } from './store.ts'

const fail = (statusCode: number, message: string): never => {
  throw Object.assign(Error(message), { statusCode })
}
const now = () => Date.now(),
  iso = (n: number) => new Date(n).toISOString()
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  )
type Row = Record<string, any>
export function service(
  dir: string,
  origin = 'http://localhost:3000',
  send: typeof fetch = fetch,
  relay = process.env.OPENPASSWORD_YOUTUBE_RELAY === '1',
) {
  const api = Fastify({ bodyLimit: 65536, routerOptions: { maxParamLength: 200 } })
  const { db, admin, seal, open } = store(dir)
  const batch = batches(db, origin, send, seal)
  const get = (sql: string, ...p: (string | number)[]) =>
    db.prepare(sql).get(...p) as Row | undefined
  const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Row[]
  const run = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).run(...p)
  if (!all('PRAGMA table_info(events)').some((x) => x.name === 'actor'))
    db.exec("ALTER TABLE events ADD COLUMN actor TEXT NOT NULL DEFAULT 'system'")
  const auditContext = new AsyncLocalStorage<{ actor: string }>()
  api.addHook('onRequest', (_r, _reply, next) => auditContext.run({ actor: 'system' }, next))
  const actor = (id: string) => {
    const current = auditContext.getStore()
    if (current) current.actor = id
  }
  const event = (t: string, action: string, id: string) =>
    run(
      'INSERT INTO events(tenant,action,subject,at,actor) VALUES(?,?,?,?,?)',
      t,
      action,
      id,
      now(),
      auditContext.getStore()?.actor || 'system',
    )
  function tx<T>(fn: () => T) {
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
  db.exec(`CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,tenant TEXT,label TEXT,role TEXT,token TEXT UNIQUE,active INTEGER);
    CREATE TABLE IF NOT EXISTS session_members(session TEXT PRIMARY KEY,member TEXT);
    CREATE TABLE IF NOT EXISTS stops(tenant TEXT PRIMARY KEY,paused INTEGER)`)
  function session(r: FastifyRequest) {
    const cookie = (r.headers.cookie || '')
      .split(/;\s*/)
      .find((x) => x.startsWith('op_session='))
      ?.slice(11)
    const s =
      get('SELECT * FROM sessions WHERE token=? AND expires>?', digest(cookie || ''), now()) ??
      fail(401, 'Unlock your workspace')
    const member = get(
      'SELECT m.* FROM members m JOIN session_members sm ON m.id=sm.member WHERE sm.session=?',
      s.token,
    )
    if (member && (!member.active || member.tenant !== s.tenant)) fail(401, 'Membership revoked')
    if (member?.role === 'viewer' && r.method !== 'GET' && r.url !== '/admin/logout')
      fail(403, 'Workspace editor required')
    actor(member?.id || 'owner')
    return {
      ...s,
      tenant: s.tenant,
      token: s.token,
      role: member?.role || 'owner',
      member: member?.id || null,
    }
  }
  function grant(r: FastifyRequest) {
    if (!/^Bearer [A-Za-z0-9_-]+$/.test(r.headers.authorization || ''))
      fail(401, 'Device bearer required')
    const g =
      get(
        'SELECT * FROM grants WHERE access=? AND active=1 AND access_until>? AND expires>?',
        digest((r.headers.authorization || '').replace(/^Bearer /, '')),
        now(),
        now(),
      ) ?? fail(401, 'Device access expired')
    actor(g.id)
    return g
  }
  const id = (r: FastifyRequest) => (r.params as { id: string }).id
  const conn = (t: string, c: string) =>
    get('SELECT * FROM connections WHERE tenant=? AND id=?', t, c) ??
    fail(404, 'Connection unavailable')
  const cookie = (v: string) =>
    'op_session=' +
    v +
    '; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800' +
    (origin.startsWith('https:') ? '; Secure' : '')
  db.exec(
    'CREATE TABLE IF NOT EXISTS read_budgets(conn TEXT PRIMARY KEY,day TEXT,used INTEGER,until INTEGER)',
  )
  const attempts = new Map<string, { count: number; until: number }>()
  api.addHook('onRequest', async (r, reply) => {
    reply.header('ZEOconnect-Protocol-Version', '1')
    if (
      r.url.startsWith('/v1/') &&
      !['/v1/chat/completions', '/v1/models'].includes(r.url.split('?')[0])
    ) {
      const values =
        r.raw.headersDistinct?.['zeoconnect-protocol-version'] ??
        (r.headers['zeoconnect-protocol-version'] === undefined
          ? []
          : [String(r.headers['zeoconnect-protocol-version'])])
      if (values.length !== 1 || values[0] !== '1') {
        const reason = !values.length
          ? 'header_missing'
          : values.length > 1 || values[0].includes(',')
            ? 'header_duplicated'
            : 'version_unsupported'
        return reply.code(426).header('Cache-Control', 'no-store').send({
          code: 'protocol_incompatible',
          reason,
          required: 'ZEOconnect-Protocol-Version: 1',
        })
      }
    }
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
    if (r.headers.origin && r.headers.origin !== origin) fail(403, 'Origin refused')
    if (
      r.url !== '/v1/youtube/uploads:relay' &&
      ['POST', 'PATCH', 'PUT'].includes(r.method) &&
      r.headers['content-type'] &&
      !r.headers['content-type'].startsWith('application/json')
    )
      fail(415, 'Use JSON')
    if (['/admin/login', '/v1/device/authorizations', '/v1/device/token'].includes(r.url)) {
      const k = r.ip + r.url,
        row = attempts.get(k)
      if (!row || row.until <= now()) attempts.set(k, { count: 1, until: now() + 60000 })
      else if (++row.count > 60) fail(429, 'Try again in one minute')
    }
  })
  api.setErrorHandler((err: Error & { statusCode?: number }, _r, reply) => {
    const status = err instanceof z.ZodError ? 422 : err.statusCode || 500
    reply.code(status).send({
      detail:
        status >= 500
          ? 'Internal service error'
          : err instanceof z.ZodError
            ? 'Invalid input'
            : err.message,
    })
  })
  api.addHook('onClose', async () => db.close())
  api.get('/health', async () => ({ status: 'ok' }))
  api.post('/admin/login', async (r, reply) => {
    const { token } = z.object({ token: name }).parse(r.body)
    const member = timingSafeEqual(Buffer.from(digest(token)), Buffer.from(admin))
      ? undefined
      : (get('SELECT * FROM members WHERE token=? AND active=1', digest(token)) ??
        fail(401, 'Invalid access token'))
    const s = opaque()
    tx(() => {
      run(
        'INSERT INTO sessions VALUES(?,?,?)',
        digest(s),
        member?.tenant || 'default',
        now() + 28800000,
      )
      if (member) run('INSERT INTO session_members VALUES(?,?)', digest(s), member.id)
    })
    reply.header('Set-Cookie', cookie(s))
    return { ok: true }
  })
  api.post('/admin/logout', async (r, reply) => {
    run('DELETE FROM sessions WHERE token=?', session(r).token)
    reply.header('Set-Cookie', cookie(''))
    return { ok: true }
  })
  api.post('/admin/workspaces', async (r) => {
    if (session(r).role !== 'owner') fail(403, 'Owner required')
    const { label } = z.object({ label: name }).parse(r.body)
    const w = randomUUID()
    run('INSERT INTO workspaces VALUES(?,?)', w, label)
    return { id: w }
  })
  api.post('/admin/switch', async (r) => {
    const s = session(r),
      w = z.object({ id: name }).parse(r.body).id
    if (s.role !== 'owner') fail(403, 'Owner required')
    if (!get('SELECT id FROM workspaces WHERE id=?', w)) fail(404, 'Unknown workspace')
    run('UPDATE sessions SET tenant=? WHERE token=?', w, s.token)
    return { ok: true }
  })
  db.exec(
    'CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, tenant TEXT, title TEXT, username TEXT, envelope TEXT, updated INTEGER)',
  )
  api.post('/admin/items', async (r) => {
    const s = session(r),
      b = z
        .object({ title: name, username: z.string().max(500), value: z.string().min(1).max(64000) })
        .strict()
        .parse(r.body),
      key = 'item_' + randomUUID()
    tx(() => {
      run(
        'INSERT INTO items VALUES(?,?,?,?,?,?)',
        key,
        s.tenant,
        b.title,
        b.username,
        seal(b.value, key),
        now(),
      )
      event(s.tenant, 'Vault item created', key)
    })
    return { id: key }
  })
  api.post('/admin/items/:id/reveal', async (r) => {
    const s = session(r),
      item =
        get('SELECT * FROM items WHERE id=? AND tenant=?', id(r), s.tenant) ??
        fail(404, 'Item unavailable')
    event(s.tenant, 'Vault item revealed', item.id)
    return { value: open(item.envelope, item.id) }
  })
  api.delete('/admin/items/:id', async (r) => {
    const s = session(r)
    return tx(() => {
      if (!run('DELETE FROM items WHERE id=? AND tenant=?', id(r), s.tenant).changes)
        fail(404, 'Item unavailable')
      event(s.tenant, 'Vault item deleted', id(r))
      return { ok: true }
    })
  })
  api.get('/admin/workspace', async (r) => {
    const s = session(r),
      t = s.tenant
    return {
      tenant: t,
      role: s.role,
      paused: !!get('SELECT paused FROM stops WHERE tenant=?', t)?.paused,
      items: all('SELECT id,title,username,updated FROM items WHERE tenant=? ORDER BY title', t),
      members:
        s.role === 'owner' ? all('SELECT id,label,role,active FROM members WHERE tenant=?', t) : [],
      workspaces:
        s.role === 'owner'
          ? all('SELECT * FROM workspaces ORDER BY label')
          : all('SELECT * FROM workspaces WHERE id=?', t),
      providers,
      connections: all(
        'SELECT id,provider,label,identity,revision,active FROM connections WHERE tenant=? ORDER BY label',
        t,
      ),
      grants: all(
        'SELECT id,label,connection_id,ops,expires,active FROM grants WHERE tenant=? ORDER BY rowid DESC',
        t,
      ),
      approvals:
        s.role === 'viewer'
          ? []
          : all(
              "SELECT id,actor,conn,op,preview,created FROM runs WHERE tenant=? AND state='pending' ORDER BY created",
              t,
            ).map((x) => ({ ...x, preview: open(x.preview, x.id + '/preview') })),
      events: all(
        'SELECT action,subject,at,actor FROM events WHERE tenant=? ORDER BY id DESC LIMIT 100',
        t,
      ),
    }
  })
  api.post('/admin/members', async (r) => {
    const s = session(r)
    if (s.role !== 'owner') fail(403, 'Owner required')
    const b = z.object({ label: name, role: z.enum(['editor', 'viewer']) }).parse(r.body),
      token = opaque(),
      m = randomUUID()
    tx(() => {
      run('INSERT INTO members VALUES(?,?,?,?,?,1)', m, s.tenant, b.label, b.role, digest(token))
      event(s.tenant, 'Member added · ' + b.role, m)
    })
    return { member_id: m, token }
  })
  api.delete('/admin/members/:id', async (r) => {
    const s = session(r)
    if (s.role !== 'owner') fail(403, 'Owner required')
    tx(() => {
      if (!run('UPDATE members SET active=0 WHERE tenant=? AND id=?', s.tenant, id(r)).changes)
        fail(404, 'Member unavailable')
      event(s.tenant, 'Member revoked', id(r))
    })
    return { ok: true }
  })
  api.post('/admin/dispatch', async (r) => {
    const s = session(r)
    if (s.role !== 'owner') fail(403, 'Owner required')
    const { paused } = z.object({ paused: z.boolean() }).parse(r.body)
    tx(() => {
      run(
        'INSERT INTO stops VALUES(?,?) ON CONFLICT(tenant) DO UPDATE SET paused=excluded.paused',
        s.tenant,
        Number(paused),
      )
      event(s.tenant, paused ? 'Dispatch paused' : 'Dispatch resumed', s.tenant)
    })
    return { paused }
  })
  function checkDispatch(tenant: string) {
    if (get('SELECT paused FROM stops WHERE tenant=?', tenant)?.paused)
      fail(423, 'Workspace dispatch paused')
  }
  api.get('/v1/session', async (r) => {
    const g = grant(r)
    return {
      device_id: g.id,
      access_expires_at: iso(g.access_until),
      grant_expires_at: iso(g.expires),
      connection_id: g.connection_id,
    }
  })
  api.get('/v1/capabilities', async (r) => {
    const g = grant(r),
      c = conn(g.tenant, g.connection_id),
      ops: string[] = JSON.parse(g.ops)
    return {
      connection_id: c.id,
      connection_revision: String(c.revision),
      external_identity: c.identity,
      operations: providers[c.provider].actions
        .filter((a) => ops.includes(a.id))
        .map((a) => ({ ...a, approval: a.method === 'GET' ? 'none' : 'exact' })),
      resources: JSON.parse(get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels || '[]'),
      model_lease:
        get('SELECT model,remaining,max_tokens FROM model_leases WHERE grant_id=?', g.id) || null,
    }
  })
  const intake = intakeKeys()
  db.exec(
    'CREATE TABLE IF NOT EXISTS intake_tickets(id TEXT PRIMARY KEY,owner TEXT,tenant TEXT,expires INTEGER)',
  )
  api.post('/admin/intake', async (r) => {
    const s = session(r),
      ticket = opaque()
    run('DELETE FROM intake_tickets WHERE expires<=?', now())
    run(
      'INSERT INTO intake_tickets VALUES(?,?,?,?)',
      digest(ticket),
      s.token,
      s.tenant,
      now() + 60000,
    )
    return { ticket, publicKey: intake.publicKey }
  })
  function intakeBody(r: FastifyRequest, field: string) {
    const b = z.record(z.string(), z.unknown()).parse(r.body)
    if (!Object.hasOwn(b, 'sealed')) return b
    const s = session(r),
      e = envelope.parse(b.sealed)
    if (
      !run(
        'DELETE FROM intake_tickets WHERE id=? AND owner=? AND tenant=? AND expires>?',
        digest(e.ticket),
        s.token,
        s.tenant,
        now(),
      ).changes
    )
      fail(403, 'Intake ticket expired')
    try {
      const { sealed, ...rest } = b
      return { ...rest, [field]: intake.unseal(e) }
    } catch {
      return fail(422, 'Invalid sealed input')
    }
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS oauth_states(id TEXT PRIMARY KEY,session TEXT,tenant TEXT,expires INTEGER,envelope TEXT)',
  )
  const callback = origin + '/api/oauth/google/callback'
  api.post('/admin/oauth/google', async (r) => {
    const s = session(r),
      b = oauthConfig.parse(intakeBody(r, 'client_secret')),
      state = opaque(),
      verifier = opaque()
    run('DELETE FROM oauth_states WHERE expires<=?', now())
    run(
      'INSERT INTO oauth_states VALUES(?,?,?,?,?)',
      digest(state),
      s.token,
      s.tenant,
      now() + 600000,
      seal({ ...b, verifier }, digest(state)),
    )
    return { url: authorize(b.client_id, b.scope, state, verifier, callback) }
  })
  api.get('/oauth/google/callback', async (r, reply) => {
    const s = session(r)
    if (s.role === 'viewer') fail(403, 'Editor required')
    const { code, state } = z
      .object({ code: z.string().min(1).max(4000), state: name })
      .parse(r.query)
    const row = tx(() => {
      const a =
        get(
          'SELECT * FROM oauth_states WHERE id=? AND session=? AND tenant=? AND expires>?',
          digest(state),
          s.token,
          s.tenant,
          now(),
        ) ?? fail(400, 'Authorization expired')
      run('DELETE FROM oauth_states WHERE id=?', a.id)
      return a
    })
    const b = open(row.envelope, row.id)
    const token = await exchange(
      {
        client_id: b.client_id,
        client_secret: b.client_secret,
        code,
        code_verifier: b.verifier,
        redirect_uri: callback,
        grant_type: 'authorization_code',
      },
      send,
    )
    const res = await send('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + token.access_token },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) fail(400, 'Google identity unavailable')
    const identity = z
      .object({ email: z.email(), email_verified: z.literal(true) })
      .parse(await res.json())
    const c = 'con_' + randomUUID()
    const bundle = {
      client_id: b.client_id,
      client_secret: b.client_secret,
      ...token,
      expires: now() + token.expires_in * 1000,
    }
    tx(() => {
      run(
        'INSERT INTO connections VALUES(?,?,?,?,?,1,?,1)',
        c,
        s.tenant,
        'google_workspace',
        b.label,
        identity.email,
        seal(bundle, c),
      )
      run('INSERT INTO resources VALUES(?,?)', c, JSON.stringify(b.resources || []))
      event(s.tenant, 'Google account connected', c)
    })
    return reply.redirect(origin + '/')
  })
  const refreshes = new Map<string, Promise<string>>()
  async function credential(c: Row): Promise<string> {
    const value = open(c.secret, c.id)
    if (typeof value === 'string') return scopedToken(c.provider, value, send)
    if (value.expires > now() + 60000) return value.access_token
    if (!value.refresh_token) return fail(409, 'Reconnect this Google account')
    const existing = refreshes.get(c.id)
    if (existing) return existing
    const pending = (async () => {
      const next = await exchange(
        {
          client_id: value.client_id,
          client_secret: value.client_secret,
          refresh_token: value.refresh_token,
          grant_type: 'refresh_token',
        },
        send,
      )
      const bundle = {
        ...value,
        ...next,
        refresh_token: next.refresh_token || value.refresh_token,
        expires: now() + next.expires_in * 1000,
      }
      if (
        !run(
          'UPDATE connections SET secret=? WHERE id=? AND revision=? AND active=1',
          seal(bundle, c.id),
          c.id,
          c.revision,
        ).changes
      )
        fail(409, 'Connection changed')
      return next.access_token
    })()
    refreshes.set(c.id, pending)
    try {
      return await pending
    } finally {
      refreshes.delete(c.id)
    }
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS resources(conn TEXT PRIMARY KEY,labels TEXT); CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,conn TEXT,actor TEXT,expires INTEGER,value TEXT)',
  )
  api.get('/v1/artifacts/:id', async (r, reply) => {
    const g = grant(r),
      a =
        get(
          'SELECT * FROM artifacts WHERE id=? AND actor=? AND conn=? AND expires>?',
          id(r),
          g.id,
          g.connection_id,
          now(),
        ) ?? fail(404, 'Artifact unavailable')
    if (!conn(g.tenant, a.conn).active) fail(404, 'Artifact unavailable')
    return reply
      .type('application/json')
      .header('Content-Disposition', 'attachment; filename="gmail-page.json"')
      .send(Buffer.from(open(a.value, a.id)))
  })
  api.post('/admin/connections', async (r) => {
    const t = session(r).tenant,
      b = connectionInput.parse(intakeBody(r, 'secret'))
    if (!Object.hasOwn(providers, b.provider)) fail(422, 'Unknown provider')
    const c = 'con_' + randomUUID()
    tx(() => {
      run(
        'INSERT INTO connections VALUES(?,?,?,?,?,1,?,1)',
        c,
        t,
        b.provider,
        b.label,
        b.external_identity,
        seal(b.secret, c),
      )
      run('INSERT INTO resources VALUES(?,?)', c, JSON.stringify(b.resources || []))
      event(t, 'Connection added', c)
    })
    return { connection_id: c }
  })
  api.post('/admin/connections/:id/rotate', async (r) => {
    const t = session(r).tenant,
      c = conn(t, id(r)),
      { secret } = z.object({ secret: z.string().min(1).max(32768) }).parse(intakeBody(r, 'secret'))
    if (!c.active) fail(409, 'Connection revoked')
    tx(() => {
      run(
        'UPDATE connections SET secret=?,revision=revision+1 WHERE id=?',
        seal(secret, c.id),
        c.id,
      )
      event(t, 'Credential rotated', c.id)
    })
    return { ok: true }
  })
  api.delete('/admin/connections/:id', async (r) => {
    const t = session(r).tenant,
      c = conn(t, id(r))
    tx(() => {
      run("UPDATE connections SET active=0,secret='',revision=revision+1 WHERE id=?", c.id)
      run('UPDATE grants SET active=0 WHERE connection_id=?', c.id)
      run("UPDATE runs SET state='denied' WHERE conn=? AND state IN ('approved','pending')", c.id)
      event(t, 'Connection revoked', c.id)
    })
    return { ok: true }
  })
  function issue(g: Row) {
    const access = opaque(),
      refresh = opaque(),
      until = Math.min(now() + 900000, g.expires)
    run(
      'UPDATE grants SET access=?,refresh=?,access_until=? WHERE id=?',
      digest(access),
      digest(refresh),
      until,
      g.id,
    )
    return {
      device_id: g.id,
      access_token: access,
      refresh_token: refresh,
      access_expires_at: iso(until),
      refresh_expires_at: iso(g.expires),
    }
  }
  api.post('/v1/device/authorizations', async (r) => {
    const label = z.object({ device_name: name }).parse(r.body).device_name,
      code = opaque(),
      u = randomBytes(5).toString('hex').toUpperCase(),
      p = randomUUID(),
      exp = now() + 600000
    run('INSERT INTO pairs VALUES(?,?,?,?,?,NULL)', p, digest(code), digest(u), label, exp)
    return {
      pairing_id: p,
      device_code: code,
      user_code: u,
      verification_url: origin + '/device',
      expires_at: iso(exp),
      interval_seconds: 5,
    }
  })
  db.exec(
    'CREATE TABLE IF NOT EXISTS model_leases(grant_id TEXT PRIMARY KEY,model TEXT,max_tokens INTEGER,remaining INTEGER)',
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS draft_limits(actor TEXT PRIMARY KEY,daily INTEGER,until INTEGER); CREATE TABLE IF NOT EXISTS draft_usage(actor TEXT,day TEXT,used INTEGER,PRIMARY KEY(actor,day))',
  )
  api.post('/admin/grants', async (r) => {
    const t = session(r).tenant,
      b = z
        .object({
          label: name,
          connection_id: name,
          operations: z.array(name).min(1),
          hours: z.number().int().min(1).max(720),
          user_code: name.optional(),
          model_lease: modelLease.optional(),
          draft_limit: z.number().int().min(1).max(100).optional(),
        })
        .parse(r.body)
    const c = conn(t, b.connection_id)
    if (
      !c.active ||
      b.operations.some((op) => !providers[c.provider].actions.some((a) => a.id === op))
    )
      fail(422, 'Invalid grant')
    return tx(() => {
      const g = 'dev_' + randomUUID(),
        expires = now() + b.hours * 3600000
      run(
        'INSERT INTO grants VALUES(?,?,?,?,?,?,NULL,NULL,0,1)',
        g,
        t,
        b.label,
        c.id,
        JSON.stringify(b.operations),
        expires,
      )
      if (b.draft_limit) {
        if (
          session(r).role !== 'owner' ||
          !b.operations.includes('loops.newsletter.create_campaign')
        )
          fail(403, 'Owner and unsent draft operation required')
        run('INSERT INTO draft_limits VALUES(?,?,?)', g, b.draft_limit, expires)
      }
      if (b.model_lease) {
        if (
          !['openai', 'openrouter', 'moonshot'].includes(c.provider) ||
          !b.operations.includes(c.provider + '.chat')
        )
          fail(422, 'Model lease requires a chat operation')
        run(
          'INSERT INTO model_leases VALUES(?,?,?,?)',
          g,
          b.model_lease.model,
          b.model_lease.max_tokens,
          b.model_lease.calls,
        )
      }
      event(t, 'Access granted', g)
      if (b.user_code) {
        if (
          !run(
            'UPDATE pairs SET grant_id=? WHERE user_code=? AND expires>? AND grant_id IS NULL',
            g,
            digest(b.user_code.toUpperCase()),
            now(),
          ).changes
        )
          fail(404, 'Pairing code unavailable')
        return { device_id: g }
      }
      return issue({ id: g, expires })
    })
  })
  api.post('/v1/device/token', async (r, reply) => {
    const code = z.object({ device_code: name }).parse(r.body).device_code
    return tx(() => {
      const p =
        get('SELECT * FROM pairs WHERE code=? AND expires>?', digest(code), now()) ??
        fail(400, 'Expired pairing')
      if (!p.grant_id) {
        reply.code(428)
        return { code: 'authorization_pending' }
      }
      const g =
        get('SELECT * FROM grants WHERE id=? AND active=1 AND expires>?', p.grant_id, now()) ??
        fail(403, 'Grant unavailable')
      run('DELETE FROM pairs WHERE id=?', p.id)
      return issue(g)
    })
  })
  api.post('/v1/device/token/refresh', async (r) => {
    const b = z.object({ refresh_token: name }).parse(r.body)
    return tx(() =>
      issue(
        get(
          'SELECT * FROM grants WHERE refresh=? AND active=1 AND expires>?',
          digest(b.refresh_token),
          now(),
        ) ?? fail(401, 'Refresh expired'),
      ),
    )
  })
  api.post('/v1/device/revoke', async (r, reply) => {
    const g = grant(r)
    run('UPDATE grants SET active=0 WHERE id=?', g.id)
    event(g.tenant, 'Access revoked', g.id)
    return reply.code(204).send()
  })
  api.delete('/admin/grants/:id', async (r) => {
    const t = session(r).tenant
    if (!run('UPDATE grants SET active=0 WHERE id=? AND tenant=?', id(r), t).changes)
      fail(404, 'Grant unavailable')
    event(t, 'Access revoked', id(r))
    return { ok: true }
  })
  api.post('/admin/approvals/:id', async (r) => {
    const t = session(r).tenant,
      { approve } = z.object({ approve: z.boolean() }).parse(r.body)
    return tx(() => {
      if (
        !run(
          "UPDATE runs SET state=? WHERE tenant=? AND id=? AND state='pending'",
          approve ? 'approved' : 'denied',
          t,
          id(r),
        ).changes
      )
        fail(409, 'Approval unavailable')
      run(
        "UPDATE batches SET state=? WHERE approval=? AND state='pending'",
        approve ? 'approved' : 'denied',
        id(r),
      )
      event(t, approve ? 'Request approved' : 'Request denied', id(r))
      return { ok: true }
    })
  })
  const fenced = (r: FastifyRequest) =>
    String(r.headers['zeoconnect-capabilities'] || '')
      .split(',')
      .map((x) => x.trim())
      .includes('expected-binding')
  api.post('/v1/connections/:id/availability', async (r) => {
    const g = grant(r)
    if (id(r) !== g.connection_id) fail(404, 'Connection unavailable')
    const c = conn(g.tenant, g.connection_id),
      b = z
        .object({
          requirement: z.object({ service: name, operations: z.array(name).min(1) }).passthrough(),
          profile: z.enum(['hosted', 'governed']),
          resource_id: name.optional(),
        })
        .strict()
        .parse(r.body)
    const ops: string[] = JSON.parse(g.ops),
      resources: string[] = JSON.parse(
        get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels || '[]',
      ),
      observed = now()
    const fact = (dimension: string, state: string, blockers: string[] = []) => ({
      dimension,
      state,
      blockers,
      revision: String(c.revision),
      observed_at: iso(observed),
      fresh_until: iso(observed + 10000),
    })
    const allowed = b.requirement.operations.every((op) => ops.includes(op))
    return {
      requirement: b.requirement,
      profile: b.profile,
      connection: { value: c.id },
      revision: String(c.revision),
      facts: [
        fact(
          'implementation',
          b.requirement.operations.every((op) =>
            providers[c.provider].actions.some((a) => a.id === op),
          )
            ? 'satisfied'
            : 'blocked',
        ),
        fact('consent', allowed ? 'satisfied' : 'blocked', allowed ? [] : ['consent_required']),
        fact(
          'resource_binding',
          b.resource_id ? (resources.includes(b.resource_id) ? 'satisfied' : 'blocked') : 'unknown',
        ),
        fact('provider_health', 'unknown'),
      ],
    }
  })
  api.get('/v1/connections', async (r) => {
    const g = grant(r),
      c = conn(g.tenant, g.connection_id)
    return [
      {
        connection_id: c.id,
        provider: c.provider,
        external_identity: c.identity,
        status: c.active ? 'active' : 'revoked',
        operations: JSON.parse(g.ops),
        resources: JSON.parse(
          get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels || '[]',
        ),
        ...(fenced(r) ? { connection_revision: String(c.revision) } : {}),
      },
    ]
  })
  api.get('/v1/models', async (r) => {
    const g = grant(r),
      lease = get('SELECT * FROM model_leases WHERE grant_id=? AND remaining>0', g.id)
    return {
      object: 'list',
      data: lease
        ? [{ id: lease.model, object: 'model', owned_by: conn(g.tenant, g.connection_id).provider }]
        : [],
    }
  })
  api.post('/v1/chat/completions', async (r, reply) => {
    const g = grant(r),
      c = conn(g.tenant, g.connection_id),
      b = chat.parse(r.body)
    if (!c.active || !JSON.parse(g.ops).includes(c.provider + '.chat'))
      fail(403, 'Model grant required')
    checkDispatch(g.tenant)
    const key =
      r.headers['idempotency-key'] === undefined
        ? randomUUID()
        : name.parse(r.headers['idempotency-key'])
    const ex = 'exec_' + randomUUID(),
      op = c.provider + '.chat'
    tx(() => {
      if (get('SELECT id FROM runs WHERE actor=? AND conn=? AND idem=?', g.id, c.id, key))
        fail(409, 'Model request already claimed')
      if (
        !run(
          'UPDATE model_leases SET remaining=remaining-1 WHERE grant_id=? AND model=? AND max_tokens>=? AND remaining>0',
          g.id,
          b.model,
          b.max_tokens,
        ).changes
      )
        fail(403, 'Model lease exhausted or out of scope')
      run(
        "INSERT INTO runs VALUES(?,?,?,?,?,?,?,?, 'running',?,NULL,?)",
        ex,
        g.tenant,
        g.id,
        c.id,
        op,
        key,
        digest(canonical(b)),
        c.revision,
        seal({}, ex + '/preview'),
        now(),
      )
      event(g.tenant, 'Model request claimed', ex)
    })
    const abort = new AbortController()
    const onClose = () => abort.abort()
    reply.raw.once('close', onClose)
    function finish(state: string) {
      reply.raw.removeListener('close', onClose)
      tx(() => {
        run('UPDATE runs SET state=? WHERE id=?', state, ex)
        event(g.tenant, op + ' · ' + state, ex)
      })
    }
    try {
      const secret = await credential(c)
      grant(r)
      checkDispatch(g.tenant)
      if (conn(g.tenant, c.id).revision !== c.revision) fail(409, 'Connection changed')
      const response = await send(providers[c.provider].origin + '/chat/completions', {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
        body: JSON.stringify(b),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw Error('Upstream refused')
      }
      const reader = response.body.getReader()
      if (b.stream && !response.headers.get('content-type')?.includes('text/event-stream')) {
        await reader.cancel()
        throw Error('Unexpected model response')
      }
      if (b.stream) {
        async function* stream() {
          let size = 0,
            done = false,
            tail = ''
          try {
            for (;;) {
              const v = await reader.read()
              if (v.done) {
                if (!/(?:^|\n)data: ?\[DONE\]\s*$/.test(tail))
                  throw Error('Incomplete model stream')
                done = true
                break
              }
              grant(r)
              checkDispatch(g.tenant)
              tail = (tail + Buffer.from(v.value).toString()).slice(-256)
              size += v.value.length
              if (size > 8388608) throw Error('Stream limit')
              yield Buffer.from(v.value)
            }
          } finally {
            abort.abort()
            await reader.cancel().catch(() => {})
            finish(done ? 'confirmed' : 'ambiguous')
          }
        }
        return reply
          .type('text/event-stream')
          .header('X-Accel-Buffering', 'no')
          .send(Readable.from(stream()))
      }
      const chunks: Buffer[] = []
      let size = 0
      for (;;) {
        const v = await reader.read()
        if (v.done) break
        size += v.value.length
        if (size > 8388608) {
          await reader.cancel()
          throw Error('Model response too large')
        }
        chunks.push(Buffer.from(v.value))
      }
      const result = JSON.parse(Buffer.concat(chunks).toString())
      finish('confirmed')
      return result
    } catch {
      abort.abort()
      finish('ambiguous')
      return fail(502, 'Model call outcome uncertain')
    }
  })
  db.exec(
    'CREATE TABLE IF NOT EXISTS uploads(proof TEXT PRIMARY KEY,link TEXT,actor TEXT,conn TEXT,revision INTEGER,size INTEGER,mime TEXT,expires INTEGER)',
  )
  api.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 4194304 },
    (_r, body, done) => done(null, body),
  )
  api.post('/v1/youtube/uploads:relay', { bodyLimit: 4194304 }, async (r) => {
    if (!relay) fail(404, 'Relay unavailable')
    const g = grant(r),
      c = conn(g.tenant, g.connection_id)
    checkDispatch(g.tenant)
    const location = String(r.headers['x-zeo-upload-link'] || ''),
      proof = String(r.headers['x-zeo-relay-seal'] || '')
    const u =
      get(
        'SELECT * FROM uploads WHERE proof=? AND link=? AND actor=? AND conn=? AND revision=? AND expires>?',
        digest(proof),
        digest(location),
        g.id,
        c.id,
        c.revision,
        now(),
      ) ?? fail(403, 'Upload not authorized')
    if (!c.active || r.headers['x-zeo-connection'] !== c.id) fail(403, 'Upload connection changed')
    const range = String(r.headers['x-zeo-content-range'] || ''),
      match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)
    const data = r.body ?? Buffer.alloc(0),
      mime = r.headers['x-zeo-content-type'] || u.mime
    const probe = range === 'bytes */' + u.size
    if (
      !Buffer.isBuffer(data) ||
      mime !== u.mime ||
      !(probe
        ? data.length === 0
        : match &&
          Number(match[3]) === u.size &&
          Number(match[2]) < u.size &&
          Number(match[2]) - Number(match[1]) + 1 === data.length &&
          data.length > 0)
    )
      fail(422, 'Invalid upload chunk')
    const token = await credential(c)
    grant(r)
    checkDispatch(g.tenant)
    if (conn(g.tenant, c.id).revision !== c.revision) fail(409, 'Connection changed')
    const response = await send(location, {
      method: 'PUT',
      redirect: 'manual',
      headers: { Authorization: 'Bearer ' + token, 'Content-Range': range, 'Content-Type': u.mime },
      body: new Uint8Array(data as Buffer),
      signal: AbortSignal.timeout(120000),
    })
    if (![200, 201, 308].includes(response.status)) {
      await response.body?.cancel()
      return { status: response.status, range: null, resource: null, reason: null }
    }
    const body = response.status !== 308 ? ((await response.json()) as Row) : {}
    if (response.status === 308) await response.body?.cancel()
    return {
      status: response.status,
      range: response.headers.get('range'),
      resource:
        response.status === 308
          ? null
          : {
              id: typeof body.id === 'string' ? body.id : null,
              status: { privacyStatus: body.status?.privacyStatus ?? null },
            },
      reason: null,
    }
  })
  api.post('/v1/operations/:operation', async (r) => {
    const g = grant(r),
      b = invocation.parse(r.body),
      operation = (r.params as { operation: string }).operation
    if (operation !== b.operation_id + ':invoke') fail(400, 'Operation mismatch')
    if (b.connection_id !== g.connection_id || !JSON.parse(g.ops).includes(b.operation_id))
      fail(403, 'Outside grant')
    const c = conn(g.tenant, b.connection_id),
      a = providers[c.provider].actions.find((x) => x.id === b.operation_id)!
    const hash = digest(
      canonical([b.operation_id, b.arguments, b.expect ?? null, b.connector_revision ?? null]),
    )
    if (
      a.id.startsWith('loops.contacts.') &&
      ['loops.contacts.import_chunk', 'loops.contacts.inspect_batch'].includes(a.id)
    ) {
      checkDispatch(g.tenant)
      if (
        b.expect &&
        (!fenced(r) ||
          b.expect.connection_revision !== String(c.revision) ||
          b.expect.external_identity !== c.identity)
      )
        fail(400, 'connection_binding_changed')
      const labels: string[] = JSON.parse(
        get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels || '[]',
      )
      return batch({
        tenant: g.tenant,
        conn: c.id,
        actor: g.id,
        op: a.id,
        key: b.idempotency_key,
        revision: c.revision,
        args: b.arguments,
        lists: labels,
        token: await credential(c),
        reauthorize: () => {
          grant(r)
          checkDispatch(g.tenant)
          if (conn(g.tenant, c.id).revision !== c.revision) fail(409, 'Connection changed')
        },
      })
    }
    const old = get(
      'SELECT * FROM runs WHERE actor=? AND conn=? AND idem=?',
      g.id,
      c.id,
      b.idempotency_key,
    )
    if (old && old.hash !== hash) fail(400, 'request_changed_under_key')
    if (old?.outcome) {
      const result = open(old.outcome, old.id + '/outcome')
      return {
        ...result,
        ...(a.id.endsWith('.upload_session.create')
          ? { result: { upload_url: null, relay_seal: null, replayed: true } }
          : {}),
        receipt: { ...result.receipt, replayed: true },
      }
    }
    if (old?.state === 'running') return { status: 'ambiguous', execution_id: old.id }
    checkDispatch(g.tenant)
    if (
      !c.active ||
      (old && old.revision !== c.revision) ||
      (b.expect &&
        (!fenced(r) ||
          b.expect.external_identity !== c.identity ||
          b.expect.connection_revision !== String(c.revision)))
    )
      fail(400, 'connection_binding_changed')
    const gmail =
      a.id.startsWith('google.gmail.') &&
      ['google.gmail.labels.list', 'google.gmail.messages.read_page'].includes(a.id)
    const revision = sourceOperation(a.id)
      ? c.provider + '.sources@1'
      : c.provider === 'google_sheets'
        ? 'google.sheets@1'
        : gmail
          ? 'google.gmail.newsroom@1'
          : '1'
    if (b.connector_revision && b.connector_revision !== revision)
      fail(400, 'Unknown connector revision')
    const ex = old?.id ?? 'exec_' + randomUUID(),
      effect = a.method !== 'GET'
    if (old?.state === 'denied') return { status: 'refused', execution_id: ex }
    const stored = open(c.secret, c.id)
    let secret = typeof stored === 'string' ? stored : stored.access_token
    let request: ReturnType<typeof buildRequest>
    try {
      request = buildRequest(
        c.provider,
        a.id,
        a.id === 'google.gmail.messages.read_page' ? {} : b.arguments,
        secret,
      )
    } catch {
      return fail(422, 'Invalid operation arguments')
    }
    if (
      ['google_sheets', 'supabase_data'].includes(c.provider) ||
      a.id === 'revolut.business.transactions.read_page'
    ) {
      const allowed: string[] = JSON.parse(
        get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels || '[]',
      )
      if (
        !allowed.includes(
          String(
            b.arguments[
              c.provider === 'google_sheets'
                ? 'spreadsheet_id'
                : c.provider === 'revolut'
                  ? 'account_id'
                  : 'table'
            ],
          ),
        )
      )
        fail(403, 'Resource outside connection')
    }
    const upload = a.id.endsWith('.upload_session.create') ? uploadRequest(a.id, b.arguments) : null
    const standing =
      !old &&
      tx(() => {
        const day = iso(now()).slice(0, 10),
          limit =
            a.id === 'loops.newsletter.create_campaign'
              ? get('SELECT daily FROM draft_limits WHERE actor=? AND until>?', g.id, now())
              : null
        const blocked =
          limit &&
          get(
            "SELECT id FROM runs WHERE conn=? AND hash=? AND state IN ('pending','denied')",
            c.id,
            hash,
          )
        const used = limit
          ? get('SELECT used FROM draft_usage WHERE actor=? AND day=?', g.id, day)?.used || 0
          : 0
        const reserve = !!limit && !blocked && used < limit.daily
        if (reserve) {
          run(
            'INSERT INTO draft_usage VALUES(?,?,1) ON CONFLICT(actor,day) DO UPDATE SET used=used+1',
            g.id,
            day,
          )
          event(g.tenant, 'Standing draft approval consumed', ex)
        }
        run(
          'INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?)',
          ex,
          g.tenant,
          g.id,
          c.id,
          a.id,
          b.idempotency_key,
          hash,
          c.revision,
          effect && !reserve ? 'pending' : 'running',
          seal(b.arguments, ex + '/preview'),
          now(),
        )
        return reserve
      })
    if (effect && !standing && (!old || old.state === 'pending'))
      return {
        status: 'approval_required',
        execution_id: ex,
        approval_url: origin + '/approvals/' + ex,
      }
    if (old && !run("UPDATE runs SET state='running' WHERE id=? AND state='approved'", ex).changes)
      fail(409, 'Execution already claimed')
    let outcome: Row
    try {
      if (
        typeof stored !== 'string' ||
        (['bluesky', 'reddit_read', 'github_read'].includes(c.provider) &&
          stored.trimStart().startsWith('{'))
      ) {
        secret = await credential(c)
        grant(r)
        checkDispatch(g.tenant)
        if (conn(g.tenant, c.id).revision !== c.revision) throw Error('Connection changed')
        request = buildRequest(
          c.provider,
          a.id,
          a.id === 'google.gmail.messages.read_page' ? {} : b.arguments,
          secret,
        )
      }
      if (sourceOperation(a.id)) {
        const result = await readSource(
          a.id,
          request.url,
          request.init.headers,
          send,
          hash,
          () =>
            tx(() => {
              grant(r)
              checkDispatch(g.tenant)
              const day = iso(now()).slice(0, 10),
                row = get('SELECT * FROM read_budgets WHERE conn=?', c.id)
              if (row && (row.until > now() || (row.day === day && row.used >= 2000)))
                throw new ReadFailure('RATE_LIMITED', 'read budget exhausted')
              run(
                'INSERT INTO read_budgets VALUES(?,?,1,0) ON CONFLICT(conn) DO UPDATE SET used=CASE WHEN day=excluded.day THEN used+1 ELSE 1 END,day=excluded.day',
                c.id,
                day,
              )
            }),
          (until) => {
            run('UPDATE read_budgets SET until=? WHERE conn=?', until, c.id)
          },
        )
        outcome = {
          status: 'confirmed',
          execution_id: ex,
          result,
          receipt: { connector_revision: revision, result_digest: 'sha256:' + result.body_sha256 },
        }
      } else if (upload) {
        const response = await send(upload.url, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + secret,
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': upload.mime,
            'X-Upload-Content-Length': String(upload.size),
          },
          body: upload.body ? JSON.stringify(upload.body) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
        })
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!response.ok || !location) throw Error('Session unavailable')
        const link = new URL(location)
        if (
          link.origin !== upload.url.origin ||
          link.pathname !== upload.url.pathname ||
          link.username ||
          link.password ||
          link.hash ||
          !link.searchParams.has('upload_id')
        )
          throw Error('Unexpected upload location')
        const proof = relay ? opaque() : null
        if (proof)
          run(
            'INSERT INTO uploads VALUES(?,?,?,?,?,?,?,?)',
            digest(proof),
            digest(location),
            g.id,
            c.id,
            c.revision,
            upload.size,
            upload.mime,
            now() + 86400000,
          )
        outcome = {
          status: 'confirmed',
          execution_id: ex,
          result: { upload_url: location, relay_seal: proof },
          receipt: { connector_revision: revision, result_digest: 'sha256:' + digest(ex) },
        }
      } else if (a.id === 'google.gmail.messages.read_page') {
        const labels = JSON.parse(
          get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels || '[]',
        )
        const body = canonical(await gmailPage(b.arguments, labels, secret, send)),
          artifact = 'art_' + randomUUID(),
          sha = 'sha256:' + digest(body)
        run('DELETE FROM artifacts WHERE expires<=?', now())
        run(
          'INSERT INTO artifacts VALUES(?,?,?,?,?)',
          artifact,
          c.id,
          g.id,
          now() + 900000,
          seal(body, artifact),
        )
        outcome = {
          status: 'confirmed',
          execution_id: ex,
          result: null,
          artifact: {
            artifact_id: artifact,
            content_sha256: sha,
            size_bytes: Buffer.byteLength(body),
            media_type: 'application/json',
            filename: 'selected-artifact',
          },
          approval_url: null,
          normalized_error: null,
          receipt: { result_digest: sha, connector_revision: revision },
        }
      } else {
        const res = await send(request.url, request.init)
        if (!res.ok) {
          await res.body?.cancel()
          throw Error('Provider refused')
        }
        const reader = res.body?.getReader()
        const chunks: Buffer[] = []
        let size = 0
        if (reader)
          for (;;) {
            const item = await reader.read()
            if (item.done) break
            size += item.value.length
            if (size > 10 * 1024 * 1024) {
              await reader.cancel()
              throw Error('Response too large')
            }
            chunks.push(Buffer.from(item.value))
          }
        const raw = Buffer.concat(chunks).toString()
        if (raw.includes(secret)) throw Error('Sensitive response')
        let result = raw
          ? JSON.parse(raw, (k: string, v: unknown, ctx?: { source?: string }) =>
              c.provider === 'revolut' &&
              typeof v === 'number' &&
              ['balance', 'amount', 'fee', 'bill_amount'].includes(k)
                ? (ctx?.source ?? String(v))
                : /^(access_token|refresh_token|client_secret|api_key|password|authorization)$/i.test(
                      k,
                    )
                  ? undefined
                  : v,
            )
          : null
        if (a.id === 'revolut.business.accounts.list') {
          const ids: string[] = JSON.parse(
            get('SELECT labels FROM resources WHERE conn=?', c.id)?.labels || '[]',
          )
          result = result.filter((x: Row) => ids.includes(x.id))
        }
        result = project(a.id, result, b.arguments)
        if (c.provider === 'google_sheets') result = sheetsResult(a.id, result)
        if (a.id === 'google.gmail.labels.list')
          result = z
            .object({ labels: z.array(z.object({ id: z.string(), name: z.string() })).max(10000) })
            .parse(result)
        outcome = {
          status: 'confirmed',
          execution_id: ex,
          result,
          receipt: {
            connector_revision: revision,
            result_digest: 'sha256:' + digest(canonical(result)),
          },
        }
      }
    } catch (e) {
      outcome = {
        status: effect ? 'ambiguous' : 'failed_safe',
        execution_id: ex,
        normalized_error:
          e instanceof GmailError || e instanceof ReadFailure
            ? { code: e.code, message: e.message }
            : gmail
              ? { code: 'REQUEST_REFUSED', message: 'gmail_response_invalid' }
              : { code: 'REQUEST_REFUSED', message: 'provider_unavailable' },
      }
    }
    const storedOutcome =
      sourceOperation(a.id) && outcome.result
        ? {
            ...outcome,
            result: Object.fromEntries(
              Object.entries(outcome.result).filter(([key]) => key !== 'body_base64'),
            ),
          }
        : outcome
    tx(() => {
      run(
        'UPDATE runs SET state=?,outcome=? WHERE id=?',
        outcome.status,
        seal(storedOutcome, ex + '/outcome'),
        ex,
      )
      event(g.tenant, a.id + ' · ' + outcome.status, ex)
    })
    return outcome
  })
  return api
}
