import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { opaque, digest } from './store.ts'
type Session = { token: string; tenant: string; role: string; member: string | null }
type Row = Record<string, any>
const strictCode = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  appId = z.string().regex(/^app_[0-9a-f-]{36}$/)
const iso = (t: number) => new Date(t).toISOString(),
  enc = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url')
const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
export function delegation(
  api: FastifyInstance,
  db: DatabaseSync,
  origin: string,
  session: (r: FastifyRequest) => Session,
  seal: (v: unknown, id: string) => string,
  open: (v: string, id: string) => any,
  event: (t: string, a: string, s: string) => unknown,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS delegation_apps(id TEXT PRIMARY KEY,tenant TEXT,label TEXT,callback TEXT,audience TEXT,expires INTEGER,active INTEGER,version INTEGER);
 CREATE TABLE IF NOT EXISTS delegation_attempts(id TEXT PRIMARY KEY,app TEXT,version INTEGER,state TEXT,challenge TEXT,expires INTEGER,session TEXT,csrf TEXT);
 CREATE TABLE IF NOT EXISTS delegation_codes(hash TEXT PRIMARY KEY,gid TEXT,app TEXT,version INTEGER,challenge TEXT,session TEXT,tenant TEXT,sub TEXT,expires INTEGER,grant_end INTEGER,used INTEGER,revoked INTEGER);
 CREATE TABLE IF NOT EXISTS delegation_signer(id INTEGER PRIMARY KEY,envelope TEXT);`)
  const run = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).run(...p)
  const get = (sql: string, ...p: (string | number)[]) =>
    db.prepare(sql).get(...p) as Row | undefined
  const current = (id: string) =>
    get('SELECT * FROM delegation_apps WHERE id=? AND active=1 AND expires>?', id, Date.now())
  const signingKey = () => {
    if (!get('SELECT id FROM delegation_signer WHERE id=1')) {
      const pair = generateKeyPairSync('ed25519')
      run(
        'INSERT OR IGNORE INTO delegation_signer VALUES(1,?)',
        seal(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), 'delegation/signing-key'),
      )
    }
    return createPrivateKey(
      open(
        get('SELECT envelope FROM delegation_signer WHERE id=1')!.envelope,
        'delegation/signing-key',
      ),
    )
  }
  const thumb = () =>
    digest(createPublicKey(signingKey()).export({ type: 'spki', format: 'pem' }).toString()).slice(
      0,
      20,
    )
  api.get('/admin/apps', async (r) => {
    const s = session(r)
    return db
      .prepare(
        'SELECT id,label,callback,audience,expires,active FROM delegation_apps WHERE tenant=? ORDER BY label',
      )
      .all(s.tenant)
  })
  api.post('/admin/apps', async (r, reply) => {
    const s = session(r)
    if (s.role !== 'owner') return reply.code(403).send({ error: 'owner_required' })
    const b = z
      .object({
        label: z.string().trim().min(1).max(160),
        callback: z.url().max(1000),
        audience: z.string().regex(/^[a-zA-Z0-9.-]{1,200}$/),
        days: z.number().int().min(1).max(365),
      })
      .strict()
      .parse(r.body)
    const uri = new URL(b.callback)
    if (uri.protocol !== 'https:' || uri.username || uri.password || uri.hash || uri.search)
      return reply.code(422).send({ error: 'invalid_uri' })
    const id = 'app_' + randomUUID()
    run(
      'INSERT INTO delegation_apps VALUES(?,?,?,?,?,?,0,1)',
      id,
      s.tenant,
      b.label,
      b.callback,
      b.audience,
      Date.now() + b.days * 86400000,
    )
    event(s.tenant, 'Identity application registered', id)
    return { id }
  })
  api.post('/admin/apps/:id', async (r, reply) => {
    const s = session(r),
      id = (r.params as { id: string }).id
    if (s.role !== 'owner') return reply.code(403).send({ error: 'owner_required' })
    const { active } = z.object({ active: z.boolean() }).strict().parse(r.body)
    if (
      !run(
        'UPDATE delegation_apps SET active=?,version=version+1 WHERE id=? AND tenant=?',
        Number(active),
        id,
        s.tenant,
      ).changes
    )
      return reply.code(404).send({ error: 'unknown_application' })
    if (active) signingKey()
    event(
      s.tenant,
      active ? 'Identity application activated' : 'Identity application suspended',
      id,
    )
    return { active }
  })
  api.get('/.well-known/zeoconnect-delegation-keys.json', async () => ({
    keys: !get('SELECT id FROM delegation_signer WHERE id=1')
      ? []
      : [
          {
            ...createPublicKey(signingKey()).export({ format: 'jwk' }),
            alg: 'EdDSA',
            use: 'sig',
            kid: thumb(),
          },
        ],
  }))
  api.get('/delegate', async (r, reply) => {
    const q = z
      .object({
        application_id: appId,
        redirect_uri: z.string(),
        state: strictCode,
        code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        code_challenge_method: z.literal('S256'),
        classes: z.literal(''),
      })
      .strict()
      .safeParse(r.query)
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' })
    const b = q.data,
      a = current(b.application_id)
    if (!a || a.callback !== b.redirect_uri)
      return reply.code(403).send({ error: 'application_refused' })
    const id = 'att_' + opaque()
    run('DELETE FROM delegation_attempts WHERE expires<=?', Date.now())
    run(
      'INSERT INTO delegation_attempts VALUES(?,?,?,?,?,?,NULL,NULL)',
      id,
      a.id,
      a.version,
      b.state,
      b.code_challenge,
      Date.now() + 300000,
    )
    return reply.redirect(origin + '/delegate/confirm?attempt=' + id, 303)
  })
  api.get('/delegate/confirm', async (r, reply) => {
    const s = session(r),
      { attempt } = z.object({ attempt: z.string() }).parse(r.query),
      t = get('SELECT * FROM delegation_attempts WHERE id=? AND expires>?', attempt, Date.now()),
      a = t && current(t.app)
    if (
      !t ||
      !a ||
      s.tenant !== a.tenant ||
      a.version !== t.version ||
      (t.session && s.token !== t.session)
    )
      return reply.code(403).send({ error: 'application_refused' })
    const csrf = opaque()
    run(
      'UPDATE delegation_attempts SET session=?,csrf=? WHERE id=?',
      s.token,
      digest(csrf),
      attempt,
    )
    return reply
      .type('text/html')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'",
      )
      .send(
        '<!doctype html><meta name="viewport" content="width=device-width"><title>Confirm sign-in · OpenPassword</title><main style="max-width:34rem;margin:12vh auto;padding:2rem;font:1rem system-ui;color:#25221e"><strong>OpenPassword</strong><h1>Sign in to ' +
          esc(a.label) +
          '?</h1><p>Share your workspace identity with ' +
          esc(a.audience) +
          ' for up to ten minutes.</p><form method="post" action="/delegate/confirm"><input type="hidden" name="attempt" value="' +
          esc(attempt) +
          '"><input type="hidden" name="csrf" value="' +
          csrf +
          '"><button style="padding:.7rem 1rem">Confirm sign-in</button></form></main>',
      )
  })
  api.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 4096 },
    (_r, b, done) => done(null, Object.fromEntries(new URLSearchParams(String(b)))),
  )
  api.post('/delegate/confirm', async (r, reply) => {
    const s = session(r)
    if (r.headers.origin !== origin) return reply.code(403).send({ error: 'application_refused' })
    const { attempt, csrf } = z
      .object({ attempt: z.string(), csrf: strictCode })
      .strict()
      .parse(r.body)
    const t = get(
        'SELECT * FROM delegation_attempts WHERE id=? AND session=? AND csrf=? AND expires>?',
        attempt,
        s.token,
        digest(csrf),
        Date.now(),
      ),
      a = t && current(t.app)
    if (!t || !a || a.tenant !== s.tenant || t.version !== a.version)
      return reply.code(403).send({ error: 'application_refused' })
    const code = opaque(),
      gid = 'gid_' + randomUUID(),
      expiry = get('SELECT expires FROM sessions WHERE token=?', s.token)!.expires
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!run('DELETE FROM delegation_attempts WHERE id=?', attempt).changes)
        throw Error('Attempt consumed')
      run(
        'INSERT INTO delegation_codes VALUES(?,?,?,?,?,?,?,?,?,?,0,0)',
        digest(code),
        gid,
        a.id,
        a.version,
        t.challenge,
        s.token,
        s.tenant,
        s.member || 'owner',
        Date.now() + 60000,
        Math.min(expiry, a.expires, Date.now() + 600000),
      )
      event(s.tenant, 'Identity granted', gid)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    const url = new URL(a.callback)
    url.search = new URLSearchParams({ code, state: t.state }).toString()
    return reply.redirect(url.href, 303)
  })
  api.post('/delegate/exchange', { bodyLimit: 4096 }, async (r, reply) => {
    if (r.headers.cookie || r.headers.origin)
      return reply.code(400).send({ error: 'invalid_request' })
    const b = z
      .object({
        grant_type: z.literal('authorization_code'),
        application_id: appId,
        redirect_uri: z.string(),
        code: strictCode,
        code_verifier: strictCode,
      })
      .strict()
      .safeParse(r.body)
    if (!b.success)
      return reply
        .code((r.body as Row)?.grant_type === 'refresh' ? 401 : 400)
        .send({
          error: (r.body as Row)?.grant_type === 'refresh' ? 'invalid_grant' : 'invalid_request',
        })
    const c = b.data,
      g = get('SELECT * FROM delegation_codes WHERE hash=?', digest(c.code)),
      a = current(c.application_id),
      now = Date.now()
    const s = g && get('SELECT * FROM sessions WHERE token=? AND expires>?', g.session, now)
    if (
      !g ||
      !a ||
      !s ||
      s.tenant !== a.tenant ||
      g.app !== a.id ||
      g.version !== a.version ||
      c.redirect_uri !== a.callback ||
      g.revoked ||
      g.expires <= now ||
      g.grant_end <= now ||
      createHash('sha256').update(c.code_verifier).digest('base64url') !== g.challenge ||
      (g.sub !== 'owner' &&
        !get('SELECT id FROM members WHERE id=? AND tenant=? AND active=1', g.sub, g.tenant))
    )
      return reply.code(401).send({ error: 'invalid_grant' })
    if (
      !run('UPDATE delegation_codes SET used=1 WHERE hash=? AND used=0', digest(c.code)).changes
    ) {
      run('UPDATE delegation_codes SET revoked=1 WHERE hash=?', digest(c.code))
      return reply.code(401).send({ error: 'invalid_grant' })
    }
    const iat = Math.floor(now / 1000),
      exp = Math.floor(g.grant_end / 1000),
      claims = {
        iss: origin,
        aud: a.audience,
        sub: g.sub,
        hiss: origin,
        org: g.tenant,
        app: a.id,
        classes: [],
        gid: g.gid,
        iat,
        nbf: iat,
        exp,
        jti: randomUUID(),
      }
    const unsigned =
      enc({ alg: 'EdDSA', kid: thumb(), typ: 'zeoconnect-human-delegation+jwt' }) +
      '.' +
      enc(claims)
    return {
      delegation:
        unsigned + '.' + sign(null, Buffer.from(unsigned), signingKey()).toString('base64url'),
      expires_at: iso(exp * 1000),
      grant_id: g.gid,
      principal: {
        hiss: origin,
        sub: g.sub,
        org: g.tenant,
        app: a.id,
        classes: [],
        grant_expires_at: iso(g.grant_end),
        session_expires_at: iso(s.expires),
        effective_expires_at: iso(g.grant_end),
      },
    }
  })
}
