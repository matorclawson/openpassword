import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)
const asset = z
  .object({
    asset_id: id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    media_type: z.enum([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'video/mp4',
      'application/pdf',
    ]),
    size_bytes: z.number().int().min(1).max(2147483648),
    alt_text: z.string().max(4096).default(''),
  })
  .strict()
const step = z
  .object({
    step_id: id,
    operation_id: z.string().regex(/^[a-zA-Z0-9_.-]{1,200}$/),
    kind: z.enum(['read', 'effect']),
    arguments: z.record(z.string(), z.unknown()),
    wait_field: z.string().min(1).max(100).nullish(),
    ready_values: z.array(z.string()).max(10).default([]),
    pending_values: z.array(z.string()).max(10).default([]),
    poll_seconds: z.number().int().min(1).max(3600).default(60),
    max_polls: z.number().int().min(1).max(1000).default(60),
  })
  .strict()
  .refine(
    (s) =>
      (!s.wait_field || (s.kind === 'read' && s.ready_values.length > 0)) &&
      !s.pending_values.some((v) => s.ready_values.includes(v)),
  )
const target = z
  .object({
    target_id: id,
    platform: z.string().regex(/^[a-z_]{1,30}$/),
    connection_id: z.string().min(1).max(200),
    expect: z
      .object({
        external_identity: z.string().min(1),
        connection_revision: z.string().regex(/^[1-9][0-9]*$/),
      })
      .strict(),
    caption: z.string().max(10000).default(''),
    asset_ids: z.array(id).max(20).default([]),
    steps: z.array(step).min(1).max(100),
    completion: z.enum(['published', 'inbox_delivered']).default('published'),
  })
  .strict()
export const publishingDraft = z
  .object({
    title: z.string().min(1).max(200),
    scheduled_at: z.iso.datetime({ offset: true }),
    assets: z.array(asset).max(100).default([]),
    targets: z.array(target).min(1).max(50),
  })
  .strict()
type Draft = z.infer<typeof publishingDraft>
type Row = Record<string, any>
type Request = {
  connection_id: string
  operation_id: string
  arguments: Record<string, unknown>
  expect: z.infer<typeof target>['expect']
  idempotency_key: string
}
const encode = (v: unknown) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  )
const hash = (v: string) => createHash('sha256').update(v).digest('hex')
function transform(
  value: any,
  lookup: (s: string, f: string) => unknown,
  media: (a: string) => unknown,
): any {
  if (Array.isArray(value)) return value.map((v) => transform(v, lookup, media))
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '$step')) {
      if (Object.keys(value).length !== 2 || typeof value.field !== 'string')
        throw Error('Invalid step reference')
      return lookup(value.$step, value.field)
    }
    if (Object.hasOwn(value, '$asset')) {
      if (Object.keys(value).length !== 1) throw Error('Invalid asset reference')
      return media(value.$asset)
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (
          /(authorization|cookie|apikey|token|secret|credentials?|password|bearer|privatekey|signingkey|secretkey)$/.test(
            k.toLowerCase().replace(/[^a-z0-9]/g, ''),
          )
        )
          throw Error('Credential in draft')
        return [k, transform(v, lookup, media)]
      }),
    )
  }
  return value
}
function validate(d: Draft) {
  const assets = new Set(d.assets.map((a) => a.asset_id))
  if (
    assets.size !== d.assets.length ||
    new Set(d.targets.map((t) => t.target_id)).size !== d.targets.length
  )
    throw Error('Duplicate asset or target')
  for (const t of d.targets) {
    if (t.asset_ids.some((a) => !assets.has(a))) throw Error('Unknown target asset')
    const seen = new Set<string>()
    for (const s of t.steps) {
      if (seen.has(s.step_id)) throw Error('Duplicate step')
      transform(
        s.arguments,
        (key) => {
          if (!seen.has(key)) throw Error('Invalid step reference')
        },
        (key) => {
          if (!t.asset_ids.includes(key)) throw Error('Invalid asset reference')
        },
      )
      seen.add(s.step_id)
    }
  }
}
export class PublishingJournal {
  private db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS posts(org TEXT,post TEXT,revision INTEGER,doc TEXT,digest TEXT,due INTEGER,approved INTEGER,cancelled INTEGER,started INTEGER,PRIMARY KEY(org,post));
   CREATE INDEX IF NOT EXISTS due_posts ON posts(org,due);
   CREATE TABLE IF NOT EXISTS targets(org TEXT,post TEXT,id TEXT,cursor INTEGER,state TEXT,polls INTEGER,next INTEGER,claim TEXT,lease INTEGER,request TEXT,outcome TEXT,PRIMARY KEY(org,post,id));
   CREATE TABLE IF NOT EXISTS receipts(org TEXT,post TEXT,target TEXT,step TEXT,result TEXT,PRIMARY KEY(org,post,target,step));
   CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,org TEXT,post TEXT,actor TEXT,action TEXT,at INTEGER);`)
  }
  close() {
    this.db.close()
  }
  private atomic<T>(work: () => T) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  private event(org: string, post: string, actor: string, action: string) {
    this.db
      .prepare('INSERT INTO events(org,post,actor,action,at) VALUES(?,?,?,?,?)')
      .run(org, post, actor, action, Date.now())
  }
  save(org: string, post: string, actor: string, revision: number, input: unknown) {
    const d = publishingDraft.parse(input)
    validate(d)
    const doc = encode(d),
      digest = hash(doc)
    if (Buffer.byteLength(doc) > 2000000) throw Error('Draft exceeds limit')
    return this.atomic(() => {
      const old = this.db.prepare('SELECT * FROM posts WHERE org=? AND post=?').get(org, post)
      if ((old?.revision ?? 0) !== revision || old?.started || old?.cancelled)
        throw Error('Revision unavailable')
      this.db
        .prepare('INSERT OR REPLACE INTO posts VALUES(?,?,?,?,?,?,0,0,0)')
        .run(org, post, revision + 1, doc, digest, Date.parse(d.scheduled_at))
      this.db.prepare('DELETE FROM targets WHERE org=? AND post=?').run(org, post)
      for (const t of d.targets)
        this.db
          .prepare("INSERT INTO targets VALUES(?,?,?,0,'ready',0,0,NULL,NULL,NULL,NULL)")
          .run(org, post, t.target_id)
      this.event(org, post, actor, 'saved')
      return { revision: revision + 1, digest }
    })
  }
  preview(org: string, post: string) {
    const p = this.db.prepare('SELECT * FROM posts WHERE org=? AND post=?').get(org, post)
    if (!p) throw Error('Unknown post')
    const { doc, ...rest } = p
    return {
      ...rest,
      draft: JSON.parse(String(doc)) as Draft,
      targets: this.db
        .prepare(
          'SELECT id,cursor,state,polls,next,outcome FROM targets WHERE org=? AND post=? ORDER BY id',
        )
        .all(org, post),
    }
  }
  calendar(org: string, start: number, end: number) {
    return this.db
      .prepare(
        'SELECT post,revision,digest,due,approved,cancelled FROM posts WHERE org=? AND due>=? AND due<? ORDER BY due,post',
      )
      .all(org, start, end)
  }
  approve(org: string, post: string, actor: string, digest: string) {
    this.atomic(() => {
      if (
        !this.db
          .prepare(
            'UPDATE posts SET approved=1 WHERE org=? AND post=? AND digest=? AND cancelled=0',
          )
          .run(org, post, digest).changes
      )
        throw Error('Approval does not match current draft')
      this.event(org, post, actor, 'approved')
    })
  }
  cancel(org: string, post: string, actor: string) {
    this.atomic(() => {
      if (
        !this.db.prepare('UPDATE posts SET cancelled=1 WHERE org=? AND post=?').run(org, post)
          .changes
      )
        throw Error('Unknown post')
      this.db
        .prepare(
          "UPDATE targets SET state='cancelled' WHERE org=? AND post=? AND state IN ('ready','waiting','approval_required')",
        )
        .run(org, post)
      this.event(org, post, actor, 'cancelled')
    })
  }
  recover(org: string, now = Date.now()) {
    return this.db
      .prepare(
        "UPDATE targets SET state='unknown',claim=NULL WHERE org=? AND state='claimed' AND lease<=?",
      )
      .run(org, now).changes
  }
  resume(org: string, post: string, id: string, actor: string) {
    this.atomic(() => {
      if (
        !this.db
          .prepare(
            "UPDATE targets SET state='ready' WHERE org=? AND post=? AND id=? AND state IN ('unknown','approval_required') AND request IS NOT NULL AND EXISTS(SELECT 1 FROM posts WHERE org=? AND post=? AND cancelled=0)",
          )
          .run(org, post, id, org, post).changes
      )
        throw Error('Target cannot resume')
      this.event(org, post, actor, 'resume exact request')
    })
  }
  async tick(
    org: string,
    invoke: (
      request: Request,
    ) => Promise<{ status: string; result?: Row | null; execution_id?: string }>,
    resolveAsset: (a: z.infer<typeof asset>) => unknown,
    now = Date.now(),
  ) {
    const task = this.atomic(() => {
      const row = this.db
        .prepare(
          "SELECT t.*,p.doc,p.digest FROM targets t JOIN posts p ON t.org=p.org AND t.post=p.post WHERE p.org=? AND p.approved=1 AND p.cancelled=0 AND p.due<=? AND t.next<=? AND t.state IN ('ready','waiting') ORDER BY p.due,p.post,t.id LIMIT 1",
        )
        .get(org, now, now) as Row | undefined
      if (!row) return null
      const d: Draft = JSON.parse(row.doc),
        t = d.targets.find((t) => t.target_id === row.id)!,
        s = t.steps[row.cursor],
        key = randomUUID()
      const req: Request = row.request
        ? JSON.parse(row.request)
        : {
            connection_id: t.connection_id,
            operation_id: s.operation_id,
            expect: t.expect,
            idempotency_key: hash(
              encode([org, row.post, row.digest, row.id, row.cursor, row.polls]),
            ),
            arguments: transform(
              s.arguments,
              (k, f) => {
                const receipt = this.db
                  .prepare(
                    'SELECT result FROM receipts WHERE org=? AND post=? AND target=? AND step=?',
                  )
                  .get(org, row.post, row.id, k)
                const rs = receipt && JSON.parse(String(receipt.result))
                if (!rs || !Object.hasOwn(rs, f)) throw Error('Missing result field')
                return rs[f]
              },
              (id) => resolveAsset(d.assets.find((a) => a.asset_id === id)!),
            ),
          }
      this.db
        .prepare(
          "UPDATE targets SET state='claimed',claim=?,lease=?,request=? WHERE org=? AND post=? AND id=?",
        )
        .run(key, now + 150000, encode(req), org, row.post, row.id)
      this.db.prepare('UPDATE posts SET started=1 WHERE org=? AND post=?').run(org, row.post)
      return { row, t, s, key, req }
    })
    if (!task) return null
    const { row, t, s, key, req } = task
    let result: Awaited<ReturnType<typeof invoke>> | undefined
    try {
      result = await invoke(req)
    } catch {}
    return this.atomic(() => {
      const active = this.db
        .prepare('SELECT claim FROM targets WHERE org=? AND post=? AND id=?')
        .get(org, row.post, row.id)
      if (active?.claim !== key) return { target_id: row.id, state: 'superseded' }
      let state = 'unknown',
        cursor = Number(row.cursor),
        polls = Number(row.polls),
        next = 0,
        request: string | null = encode(req)
      if (result?.status === 'approval_required') state = 'approval_required'
      if (['refused', 'failed_safe'].includes(result?.status ?? '')) state = 'failed'
      if (result?.status === 'confirmed' && result.result && typeof result.result === 'object') {
        const r = result.result
        if (s.wait_field && !s.ready_values.includes(r[s.wait_field])) {
          state =
            s.pending_values.includes(r[s.wait_field]) && ++polls < s.max_polls
              ? 'waiting'
              : 'failed'
          next = now + s.poll_seconds * 1000
          request = null
        } else if (cursor + 1 === t.steps.length && r.stage !== t.completion) {
          state = s.kind === 'read' ? 'failed' : 'unknown'
        } else {
          this.db
            .prepare('INSERT OR REPLACE INTO receipts VALUES(?,?,?,?,?)')
            .run(org, row.post, row.id, s.step_id, encode(r))
          cursor++
          polls = 0
          request = null
          state = cursor === t.steps.length ? t.completion : 'ready'
        }
      }
      if (
        ['ready', 'waiting', 'approval_required'].includes(state) &&
        this.db.prepare('SELECT cancelled FROM posts WHERE org=? AND post=?').get(org, row.post)
          ?.cancelled
      )
        state = 'cancelled'
      this.db
        .prepare(
          'UPDATE targets SET state=?,cursor=?,polls=?,next=?,claim=NULL,request=?,outcome=? WHERE org=? AND post=? AND id=?',
        )
        .run(
          state,
          cursor,
          polls,
          next,
          request,
          result ? encode({ status: result.status, execution_id: result.execution_id }) : null,
          org,
          row.post,
          row.id,
        )
      this.event(org, row.post, 'workflow', state)
      return { target_id: row.id, state }
    })
  }
}

/** Compose a target using the operation IDs exposed by the OpenPassword broker. */
export function composePublishingTarget(input: {
  platform: 'instagram' | 'threads' | 'tiktok' | 'x' | 'facebook' | 'mastodon'
  target_id: string
  account_id: string
  connection_id: string
  expect: z.infer<typeof target>['expect']
  caption: string
  assets: z.infer<typeof asset>[]
  mode?: 'publish' | 'inbox'
  privacy_level?: string
}) {
  const { platform, account_id: id, caption, assets } = input,
    steps: z.input<typeof step>[] = []
  const add = (
    step_id: string,
    operation_id: string,
    args: Record<string, unknown>,
    extra: Partial<z.input<typeof step>> = {},
  ) => steps.push({ step_id, operation_id, arguments: args, kind: 'effect', ...extra })
  const ref = (s: string, f = 'container_id') => ({ $step: s, field: f }),
    media = (a: z.infer<typeof asset>) => ({ $asset: a.asset_id })
  if (platform === 'instagram' || platform === 'threads') {
    const ig = platform === 'instagram',
      create = ig ? 'instagram.media.create' : 'threads.draft'
    if (
      assets.length > 10 ||
      assets.some(
        (a) =>
          !(ig ? ['image/jpeg', 'video/mp4'] : ['image/jpeg', 'image/png', 'video/mp4']).includes(
            a.media_type,
          ),
      ) ||
      (ig && !assets.length) ||
      (!ig && !caption.trim()) ||
      Array.from(caption).length > (ig ? 2200 : 500)
    )
      throw Error('Unsupported media or caption')
    const ready = (s: string) =>
      add(
        'ready_' + s,
        platform + '.status',
        { id: ref(s), fields: ig ? 'status_code' : 'status' },
        {
          kind: 'read',
          wait_field: 'provider_status',
          ready_values: ['FINISHED'],
          pending_values: ['IN_PROGRESS'],
        },
      )
    const item = (a: z.infer<typeof asset>) => ({
      media_type:
        a.media_type === 'video/mp4' ? (ig && assets.length === 1 ? 'REELS' : 'VIDEO') : 'IMAGE',
      [a.media_type === 'video/mp4' ? 'video_url' : 'image_url']: media(a),
    })
    if (assets.length > 1) {
      assets.forEach((a, i) => {
        const key = 'item' + i
        add(key, create, { id, ...item(a), is_carousel_item: true })
        ready(key)
      })
      add('container', create, {
        id,
        media_type: 'CAROUSEL',
        children: assets.map((_, i) => ref('item' + i)),
        [ig ? 'caption' : 'text']: caption,
      })
    } else
      add('container', create, {
        id,
        ...(assets.length ? item(assets[0]) : { media_type: 'TEXT' }),
        [ig ? 'caption' : 'text']: caption,
      })
    ready('container')
    add('publish', platform + '.publish', { id, creation_id: ref('container') })
  } else if (platform === 'tiktok') {
    if (
      assets.length !== 1 ||
      assets[0].media_type !== 'video/mp4' ||
      (input.mode !== 'inbox' && !input.privacy_level)
    )
      throw Error('One MP4 and explicit publication privacy or inbox mode required')
    const inbox = input.mode === 'inbox'
    add('upload', inbox ? 'tiktok.inbox' : 'tiktok.publish', {
      video_url: media(assets[0]),
      ...(inbox ? {} : { title: caption, privacy_level: input.privacy_level }),
    })
    add(
      'status',
      'tiktok.status',
      { publish_id: ref('upload', 'publish_id') },
      {
        kind: 'read',
        wait_field: 'stage',
        ready_values: [inbox ? 'inbox_delivered' : 'published'],
        pending_values: ['processing'],
        max_polls: 120,
      },
    )
  } else {
    if (assets.length || !caption.trim() || (platform === 'x' && Array.from(caption).length > 280))
      throw Error('Unsupported text post')
    add(
      'publish',
      platform === 'facebook' ? 'facebook.post' : platform + '.publish',
      platform === 'facebook'
        ? { id, message: caption }
        : platform === 'mastodon'
          ? { status: caption }
          : { text: caption },
    )
  }
  return target.parse({
    target_id: input.target_id,
    platform,
    connection_id: input.connection_id,
    expect: input.expect,
    caption,
    asset_ids: assets.map((a) => a.asset_id),
    steps,
    completion: platform === 'tiktok' && input.mode === 'inbox' ? 'inbox_delivered' : 'published',
  })
}
