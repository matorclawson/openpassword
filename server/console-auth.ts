import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { z } from 'zod'
import { digest, opaque } from './store.ts'

const derive = promisify(scrypt)
const credentials = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(256),
})
const services = {
  google: [
    'https://accounts.google.com/o/oauth2/v2/auth',
    'https://oauth2.googleapis.com/token',
    'https://openidconnect.googleapis.com/v1/userinfo',
    'openid',
  ],
  github: [
    'https://github.com/login/oauth/authorize',
    'https://github.com/login/oauth/access_token',
    'https://api.github.com/user',
    'read:user',
  ],
}
const idSchema = z.enum(['google', 'github'])
function refuse(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode })
}
export function consoleAuth(
  api: FastifyInstance,
  db: DatabaseSync,
  origin: string,
  admin: string,
  session: (r: FastifyRequest) => { role: string; token: string },
  login: (reply: FastifyReply) => void,
  seal: (v: unknown, c: string) => string,
  open: (v: string, c: string) => any,
  send: typeof fetch,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS console_owner(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT,salt TEXT,hash TEXT);
    CREATE TABLE IF NOT EXISTS signin_apps(provider TEXT PRIMARY KEY,client TEXT,secret TEXT,subject TEXT);
    CREATE TABLE IF NOT EXISTS signin_attempts(state TEXT PRIMARY KEY,provider TEXT,browser TEXT,verifier TEXT,session TEXT,expires INTEGER);`)
  const owner = () => db.prepare('SELECT * FROM console_owner WHERE id=1').get()
  const app = (p: string) => db.prepare('SELECT * FROM signin_apps WHERE provider=?').get(p)
  const callback = (p: string) => origin + '/api/auth/' + p + '/callback'
  const provider = (r: FastifyRequest) =>
    idSchema.parse((r.params as { provider: string }).provider)
  const requireOwner = (r: FastifyRequest) => {
    const s = session(r)
    if (s.role !== 'owner' || !owner()) refuse(403, 'Administrator account required')
    return s
  }
  api.get('/auth/status', async () => ({
    setup: !owner(),
    origin,
    providers: db
      .prepare('SELECT provider FROM signin_apps WHERE subject IS NOT NULL')
      .all()
      .map((x) => x.provider),
  }))
  api.post('/auth/setup', async (r, reply) => {
    const b = credentials
      .extend({ password: z.string().min(12).max(256), token: z.string().max(256) })
      .parse(r.body)
    if (owner()) refuse(409, 'Administrator already created')
    if (!timingSafeEqual(Buffer.from(digest(b.token)), Buffer.from(admin)))
      refuse(403, 'Incorrect setup code')
    const salt = randomBytes(16).toString('hex'),
      hash = (await derive(b.password, salt, 64)) as Buffer
    if (
      !db
        .prepare('INSERT OR IGNORE INTO console_owner VALUES(1,?,?,?)')
        .run(b.username, salt, hash.toString('hex')).changes
    )
      refuse(409, 'Administrator already created')
    login(reply)
    return { ok: true }
  })
  api.post('/auth/password', async (r, reply) => {
    const b = credentials.parse(r.body),
      a = owner()
    if (!a) refuse(401, 'Invalid username or password')
    const hash = (await derive(b.password, String(a.salt), 64)) as Buffer
    if (!timingSafeEqual(hash, Buffer.from(String(a.hash), 'hex')) || b.username !== a.username)
      refuse(401, 'Invalid username or password')
    login(reply)
    return { ok: true }
  })
  api.get('/admin/authentication', async (r) => {
    requireOwner(r)
    return Object.keys(services).map((provider) => {
      const a = app(provider)
      return {
        provider,
        callback: callback(provider),
        client: String(a?.client ?? ''),
        linked: !!a?.subject,
      }
    })
  })
  api.post('/admin/authentication/:provider', async (r) => {
    requireOwner(r)
    const p = provider(r),
      b = z
        .object({ client: z.string().trim().min(1).max(512), secret: z.string().min(1).max(2048) })
        .parse(r.body)
    db.prepare('INSERT OR REPLACE INTO signin_apps VALUES(?,?,?,NULL)').run(
      p,
      b.client,
      seal(b.secret, 'signin/' + p),
    )
    db.prepare('DELETE FROM signin_attempts WHERE provider=?').run(p)
    return { ok: true }
  })
  api.delete('/admin/authentication/:provider', async (r) => {
    requireOwner(r)
    const p = provider(r)
    db.prepare('DELETE FROM signin_apps WHERE provider=?').run(p)
    db.prepare('DELETE FROM signin_attempts WHERE provider=?').run(p)
    return { ok: true }
  })
  const stateCookie = (value: string, age: number) =>
    'op_signin=' +
    value +
    '; Path=/api/auth/; HttpOnly; SameSite=Lax; Max-Age=' +
    age +
    (origin.startsWith('https:') ? '; Secure' : '')
  api.post('/auth/:provider/start', async (r, reply) => {
    const p = provider(r),
      { link } = z.object({ link: z.boolean() }).parse(r.body)
    const sessionId = link ? requireOwner(r).token : null,
      a = app(p)
    if (!a || (!link && !a.subject)) refuse(404, 'Sign-in provider unavailable')
    const state = opaque(),
      browser = opaque(),
      verifier = opaque()
    db.prepare('DELETE FROM signin_attempts WHERE expires<=?').run(Date.now())
    db.prepare('INSERT INTO signin_attempts VALUES(?,?,?,?,?,?)').run(
      digest(state),
      p,
      digest(browser),
      verifier,
      sessionId,
      Date.now() + 600000,
    )
    const url = new URL(services[p][0])
    url.search = new URLSearchParams({
      client_id: String(a.client),
      redirect_uri: callback(p),
      response_type: 'code',
      scope: services[p][3],
      state,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString()
    reply.header('Set-Cookie', stateCookie(browser, 600))
    return { url: url.href }
  })
  api.get('/auth/:provider/callback', async (r, reply) => {
    const p = provider(r),
      { state, code } = r.query as Record<string, string>
    const browser = r.headers.cookie
      ?.split(/;\s*/)
      .find((v) => v.startsWith('op_signin='))
      ?.slice(10)
    if (!browser || typeof state !== 'string') return reply.redirect('/?signin=failed')
    const t = db
      .prepare(
        'DELETE FROM signin_attempts WHERE state=? AND browser=? AND provider=? AND expires>? RETURNING *',
      )
      .get(digest(state), digest(browser), p, Date.now())
    reply.header('Set-Cookie', stateCookie('', 0))
    try {
      const a = app(p)
      if (!a || !t || !code || (t.session && requireOwner(r).token !== t.session))
        return reply.redirect('/?signin=failed')
      const token = await send(services[p][1], {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: String(a.client),
          client_secret: open(String(a.secret), 'signin/' + p),
          code,
          code_verifier: String(t.verifier),
          grant_type: 'authorization_code',
          redirect_uri: callback(p),
        }),
      })
      if (!token.ok) return reply.redirect('/?signin=failed')
      const access = z
        .string()
        .min(1)
        .parse((await token.json()).access_token)
      const user = await send(services[p][2], {
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: 'Bearer ' + access,
          Accept: 'application/json',
          'User-Agent': 'OpenPassword',
        },
      })
      if (!user.ok) return reply.redirect('/?signin=failed')
      const info = await user.json()
      const sub =
        p === 'google'
          ? z.string().min(1).parse(info.sub)
          : String(z.number().int().positive().parse(info.id))
      if (t.session) {
        if (
          requireOwner(r).token !== t.session ||
          !db
            .prepare('UPDATE signin_apps SET subject=? WHERE provider=? AND secret=?')
            .run(sub, p, a.secret).changes
        )
          return reply.redirect('/?signin=failed')
      } else {
        const live = app(p)
        if (live?.subject !== sub || live.secret !== a.secret)
          return reply.redirect('/?signin=failed')
        login(reply)
      }
      return reply.redirect(t.session ? '/?signin=linked' : '/')
    } catch {
      return reply.redirect('/?signin=failed')
    }
  })
  return owner
}
