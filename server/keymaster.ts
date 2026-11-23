import type { FastifyInstance, FastifyRequest } from 'fastify'
import { visit } from 'jsonc-parser'
import { z } from 'zod'

const sha = z.string().regex(/^[a-f0-9]{40}$/),
  repository = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/),
  ref = z.string().regex(/^refs\/heads\/.{1,250}$/),
  branch = z.string().min(1).max(250),
  cursor = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,512}$/)
    .optional()
const number = z.number().int().positive(),
  idem = z.string().regex(/^[A-Za-z0-9._:-]{32,128}$/)
const principal = z
  .object({
    principal_id: z.string().regex(/^prn_[A-Za-z0-9_-]{1,64}$/),
    incarnation: number,
    authenticated_as: z
      .object({
        host_id: z.string().regex(/^host_[A-Za-z0-9_-]{1,64}$/),
        host_incarnation: number,
        os_account: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
        account_incarnation: number,
      })
      .strict(),
  })
  .strict()
const path = z
  .string()
  .min(1)
  .refine(
    (v) =>
      Buffer.byteLength(v) <= 4096 &&
      v === v.normalize('NFC') &&
      !v.includes('\0') &&
      v.split('/').every((s) => s && s !== '.' && s !== '..' && s.toLowerCase() !== '.git'),
  )
const change = z.union([
  z.object({ path, delete: z.literal(true) }).strict(),
  z
    .object({
      path,
      mode: z.enum(['100644', '100755', '120000']),
      content_base64: z
        .string()
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    })
    .strict(),
])
const common = { repository, number },
  prFields = { title: z.string().min(1).optional(), body: z.string().optional() }
const schemas: Record<string, z.ZodType> = {
  'github.git.publish': z
    .object({
      repository,
      ref,
      expected_old_sha: sha.nullable(),
      parents: z.array(sha).min(1).max(2),
      changes: z
        .array(change)
        .min(1)
        .max(500)
        .refine((cs) => new Set(cs.map((c) => c.path.toUpperCase())).size === cs.length),
      message: z.string().min(1),
      author: z
        .object({ name: z.string().min(1).max(256), email: z.string().min(3).max(256) })
        .strict(),
    })
    .strict(),
  'github.git.reconcile': z
    .object({ execution_id: z.string().regex(/^exe_[A-Za-z0-9_-]{1,64}$/) })
    .strict(),
  'github.intent.resolve': z
    .object({ idempotency_key: idem, request_sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict(),
  'github.pr.open': z
    .object({
      repository,
      head: branch,
      head_sha: sha,
      title: z.string().min(1),
      body: z.string(),
      draft: z.boolean(),
      base: branch.optional(),
    })
    .strict(),
  'github.pr.update': z
    .object({ ...common, ...prFields, state: z.literal('closed').optional() })
    .strict()
    .refine((v) => v.title !== undefined || v.body !== undefined || v.state !== undefined),
  'github.contents.read': z
    .object({ repository, path, ref: ref.optional(), sha: sha.optional(), cursor })
    .strict()
    .refine((v) => Boolean(v.ref) !== Boolean(v.sha)),
  'github.pr.read': z
    .object({
      ...common,
      include: z
        .array(z.enum(['files', 'reviews', 'commits']))
        .max(3)
        .refine((v) => new Set(v).size === v.length),
      cursor,
    })
    .strict(),
  'github.checks.read': z.object({ repository, sha, cursor }).strict(),
  'github.pr.list': z
    .object({
      repository,
      state: z.enum(['open', 'closed', 'all']),
      updated_since: z.iso.datetime({ offset: true }).optional(),
      cursor,
    })
    .strict(),
  'github.ref.read': z.object({ repository, ref }).strict(),
  'github.fork.sync': z.object({ repository }).strict(),
}
const base = z
  .object({
    connection_id: z.string().regex(/^role_[A-Za-z0-9_-]{1,64}$/),
    operation_id: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    idempotency_key: idem,
    on_behalf_of: principal,
    door_request_id: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  })
  .strict()
const invalid = (reason: string) => ({ status: 422, body: { code: 'invalid_request', reason } })
const gate = { status: 503, body: { code: 'unavailable', reason: 'not_enrolled' } }
function safeParse(raw: string) {
  const stack: Set<string>[] = []
  let valid = true
  visit(
    raw,
    {
      onObjectBegin: () => {
        stack.push(new Set())
      },
      onObjectProperty: (k) => {
        if (stack.at(-1)?.has(k)) valid = false
        stack.at(-1)?.add(k)
      },
      onObjectEnd: () => {
        stack.pop()
      },
      onError: () => {
        valid = false
      },
    },
    { disallowComments: true },
  )
  if (!valid) throw Error('Invalid JSON')
  return JSON.parse(raw)
}
export function admitGithub(op: string, raw: string, pr: boolean) {
  let b
  try {
    b = safeParse(raw)
  } catch {
    return invalid('body_invalid')
  }
  if (!b || b.operation_id !== op) return invalid('body_invalid')
  if (!principal.safeParse(b.on_behalf_of).success) return invalid('on_behalf_of_invalid')
  if (!base.shape.door_request_id.safeParse(b.door_request_id).success)
    return invalid('door_request_id_invalid')
  if (
    !base.safeParse(b).success ||
    !schemas[op]?.safeParse(b.arguments).success ||
    (!pr && op === 'github.pr.update' && b.arguments.state !== undefined)
  )
    return invalid('body_invalid')
  const a = b.arguments
  if (
    (a.title && Buffer.byteLength(a.title) > 1024) ||
    (a.body && Buffer.byteLength(a.body) > 49152) ||
    (a.message && Buffer.byteLength(a.message) > 65536) ||
    a.changes?.some(
      (c: { content_base64?: string }) =>
        c.content_base64 && Buffer.byteLength(c.content_base64, 'base64') > 1048576,
    )
  )
    return { status: 413, body: { code: 'request_too_large' } }
  if (a.title && Array.from(a.title).length > 256) return invalid('body_invalid')
  return gate
}
export function keymaster(
  api: FastifyInstance,
  authenticate: (r: FastifyRequest) => { tenant: string },
  paused: (tenant: string) => boolean,
) {
  api.register(async (scope) => {
    scope.removeContentTypeParser('application/json')
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, b, done) =>
      done(null, b),
    )
    const caps = (r: FastifyRequest) =>
      String(r.headers['openpassword-capabilities'] ?? '')
        .split(',')
        .map((x) => x.trim())
    for (const op of Object.keys(schemas))
      scope.post(
        '/v1/operations/' + op + '::invoke',
        { bodyLimit: op === 'github.git.publish' ? 8388608 : 65536 },
        async (r, reply) => {
          const g = authenticate(r),
            options = caps(r)
          if (!options.includes('github-keymaster'))
            return reply.code(422).send(invalid('capability_missing').body)
          if (!['github.git.reconcile', 'github.intent.resolve'].includes(op) && paused(g.tenant))
            return reply
              .code(403)
              .send({ code: 'stopped', control: 'admission', scope: 'organization' })
          const answer = admitGithub(op, String(r.body), options.includes('github-pr-provider'))
          return reply.code(answer.status).send(answer.body)
        },
      )
    for (const path of ['receipts', 'topology'])
      scope.get('/v1/github/' + path, async (r, reply) => {
        authenticate(r)
        if (!caps(r).includes('github-keymaster'))
          return reply.code(422).send(invalid('capability_missing').body)
        try {
          const h = String(r.headers['openpassword-on-behalf-of'] || ''),
            raw = Buffer.from(h, 'base64url'),
            v = principal.parse(safeParse(raw.toString()))
          const canon = JSON.stringify(v, (_, x) =>
            x && typeof x === 'object'
              ? Object.fromEntries(
                  Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
                )
              : x,
          )
          if (Buffer.from(canon).toString('base64url') !== h) throw Error()
        } catch {
          return reply.code(422).send(invalid('on_behalf_of_invalid').body)
        }
        return reply.code(503).send(gate.body)
      })
  })
}
