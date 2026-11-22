import { checkContactEmail } from '../packages/connectors/contact-email.ts'
import { batchView } from './batch-view.ts'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { loopsPacer } from './loops-pacing.ts'
import { z } from 'zod'
import { digest } from './store.ts'
const text = z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/),
  sha = z.string().regex(/^[a-f0-9]{64}$/)
const utc = z.iso.datetime({ precision: 0 })
const manifest = z
  .object({
    schema: z.literal('zeoconnect-batch-manifest/1'),
    operation: z.literal('loops.contacts.import_chunk'),
    organization: text,
    connection: text,
    list_id: text,
    list_name: z
      .string()
      .min(1)
      .max(200)
      .refine((v) => !/[\p{C}\r\n]/u.test(v) && v === v.normalize('NFC')),
    row_count: z.number().int().min(1).max(100000),
    chunk_size: z.number().int().min(1).max(100),
    chunk_count: z.number().int().min(1).max(1000),
    chunk_counts: z.array(z.number().int().positive()).max(1000),
    chunk_digests: z.array(sha).max(1000),
    properties_allowed: z.array(z.literal('source')).max(1),
    policy_id: text,
    policy_revision: text,
    record_id: text,
    run_id: text,
    snapshot_version: text,
    reason_code: text,
    distinct_attested: z.object({ email: z.literal(true), user_id: z.literal(true) }).strict(),
    window: z.object({ not_before: utc, expires_at: utc }).strict(),
    workflows: z.enum(['checked', 'may_trigger']).default('checked'),
  })
  .strict()
  .refine(
    (m) =>
      m.chunk_count === m.chunk_counts.length &&
      m.chunk_digests.length === m.chunk_count &&
      new Set(m.chunk_digests).size === m.chunk_count &&
      m.chunk_counts.every((n) => n <= m.chunk_size) &&
      m.chunk_counts.reduce((a, b) => a + b, 0) === m.row_count &&
      Date.parse(m.window.expires_at) > Date.parse(m.window.not_before) &&
      Date.parse(m.window.expires_at) - Date.parse(m.window.not_before) <= 7200000,
  )
type Manifest = z.infer<typeof manifest>
const row = z
  .object({
    email: z.string().refine((s) => checkContactEmail(s) === 'ok'),
    user_id: z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/),
    source: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{0,64}$/)
      .optional(),
  })
  .strict()
const chunk = z
  .object({
    batch_id: text,
    index: z.number().int().min(0).max(999),
    rows: z.array(row).min(1).max(100),
    resume: z
      .object({ snapshot_version: text, stops_unchanged: z.literal(true) })
      .strict()
      .optional(),
  })
  .strict()
type Row = Record<string, any>
type Context = {
  tenant: string
  conn: string
  actor: string
  op: string
  key: string
  revision: number
  args: Record<string, unknown>
  lists: string[]
  token: string
  reauthorize: () => void
}
const canon = (v: unknown) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  )
const denied = (message: string) => ({
  status: 'refused',
  normalized_error: { code: 'REQUEST_REFUSED', message },
})
export function batches(
  db: DatabaseSync,
  origin: string,
  paced: ReturnType<typeof loopsPacer>,
  seal: (v: unknown, ctx: string) => string,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,approval TEXT,tenant TEXT,conn TEXT,actor TEXT,revision INTEGER,manifest TEXT,hash TEXT,state TEXT,reason TEXT,idx INTEGER,sent INTEGER,accepted INTEGER,refused INTEGER,ambiguous INTEGER,UNIQUE(actor,conn,hash));
 CREATE TABLE IF NOT EXISTS batch_baselines(batch TEXT,idx INTEGER,sent INTEGER,accepted INTEGER,refused INTEGER,ambiguous INTEGER,resumes INTEGER,snapshot TEXT,PRIMARY KEY(batch,idx));
 CREATE TABLE IF NOT EXISTS batch_decisions(approval TEXT PRIMARY KEY,decided INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS batch_keys(actor TEXT,conn TEXT,idem TEXT,digest TEXT,batch TEXT,idx INTEGER,outcome TEXT,PRIMARY KEY(actor,conn,idem));`)
  // The supported deployment owns one broker process and one SQLite database.
  db.exec("UPDATE batches SET state='halted',reason='ambiguous_halt' WHERE state='claimed'")
  const find = (sql: string, ...p: (number | string)[]) =>
    db.prepare(sql).get(...p) as Row | undefined
  const run = (sql: string, ...p: (number | string | null)[]) => db.prepare(sql).run(...p)
  function summary(b: Row, m: Manifest) {
    return {
      view: batchView(db, b),
      batch_id: b.id,
      approval_id: b.approval,
      state: b.state,
      reason: b.reason,
      workflows: m.workflows,
      manifest_sha256: b.hash,
      batch_sha256: digest(canon(m.chunk_digests)),
      sent: b.sent,
      accepted: b.accepted,
      refused: b.refused,
      ambiguous: b.ambiguous,
      chunks_done: b.idx,
    }
  }
  async function http(c: Context, path: string, deadline: number, body?: unknown) {
    const r = await paced(
      c.conn,
      'https://app.loops.so/api/v1/' + path,
      {
        method: body ? 'PUT' : 'GET',
        headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      },
      deadline,
      c.reauthorize,
    )
    if (!r.ok) {
      await r.body?.cancel()
      throw Error(
        [401, 403].includes(r.status)
          ? 'credential_refused'
          : r.status === 429
            ? 'rate_exhausted'
            : [400, 404, 405, 409, 410, 413, 415, 422].includes(r.status)
              ? 'loops_refused'
              : 'ambiguous_halt',
      )
    }
    return r.json()
  }
  async function workflows(c: Context, m: Manifest) {
    if (m.workflows === 'may_trigger') return
    const deadline = Date.now() + 30000,
      ids = new Set<string>()
    let cursor = ''
    for (let i = 0; i < 20; i++) {
      const p = await http(
        c,
        'workflows?perPage=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        deadline,
      )
      if (!Array.isArray(p.data) || !p.pagination) throw Error('loops_refused')
      for (const v of p.data) ids.add(text.parse(v.id))
      cursor = p.pagination.nextCursor ?? ''
      if (!cursor) break
      if (i === 19) throw Error('loops_refused')
    }
    for (const id of ids) {
      const w = await http(c, 'workflows/' + encodeURIComponent(id), deadline)
      if (['Draft', 'Paused'].includes(w.status)) continue
      if (!['Sending', 'PausedAndQueueing'].includes(w.status) || !w.nodes)
        throw Error('loops_refused')
      const nodes = Object.values(w.nodes) as Row[]
      if (nodes.some((n) => typeof n?.typeName !== 'string')) throw Error('loops_refused')
      const triggers = nodes.filter((n) => n.typeName.endsWith('Trigger'))
      if (!triggers.length) throw Error('loops_refused')
      for (const n of triggers) {
        if (
          n.typeName === 'SignupTrigger' ||
          (n.typeName === 'AddToListTrigger' &&
            (!n.mailingListId || n.mailingListId === m.list_id)) ||
          (n.typeName === 'ContactPropertyTrigger' &&
            (!n.contactPropertyQuery?.key ||
              ['email', 'userId', ...m.properties_allowed].includes(n.contactPropertyQuery.key)))
        )
          throw Error('workflow_live')
        if (
          !['AddToListTrigger', 'ContactPropertyTrigger', 'EventTrigger', 'BlankTrigger'].includes(
            n.typeName,
          )
        )
          throw Error('loops_refused')
      }
    }
  }
  function fixed(e: unknown) {
    const word = e instanceof Error ? e.message : ''
    return ['workflow_live', 'credential_refused', 'rate_exhausted', 'loops_refused'].includes(word)
      ? word
      : 'ambiguous_halt'
  }
  function atomic<T>(fn: () => T) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      db.exec('COMMIT')
      return r
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  return async function handle(c: Context) {
    const byId = (id: string) =>
      find(
        'SELECT * FROM batches WHERE id=? AND tenant=? AND conn=? AND actor=?',
        id,
        c.tenant,
        c.conn,
        c.actor,
      )
    const reqHash = digest(canon(c.args)),
      prev = find(
        'SELECT * FROM batch_keys WHERE actor=? AND conn=? AND idem=?',
        c.actor,
        c.conn,
        c.key,
      )
    if (prev && prev.digest !== reqHash) return denied('request_changed_under_key')
    if (c.op === 'loops.contacts.inspect_batch') {
      const b = byId(z.object({ batch_id: text }).strict().parse(c.args).batch_id)
      if (!b) return denied('unknown_batch')
      return {
        status: 'confirmed',
        execution_id: b.approval,
        result: summary(b, JSON.parse(b.manifest)),
      }
    }
    if (Object.hasOwn(c.args, 'manifest')) {
      const m = z.object({ manifest }).strict().parse(c.args).manifest,
        hash = digest(canon(m))
      if (m.organization !== c.tenant || m.connection !== c.conn) return denied('manifest_mismatch')
      if (!c.lists.includes(m.list_id)) return denied('list_mismatch')
      if (Date.parse(m.window.expires_at) <= Date.now()) return denied('window_refused')
      let b = find(
        'SELECT * FROM batches WHERE actor=? AND conn=? AND hash=?',
        c.actor,
        c.conn,
        hash,
      )
      if (!b) {
        try {
          await workflows(c, m)
          c.reauthorize()
        } catch (e) {
          return denied(fixed(e))
        }
        b = atomic(() => {
          const duplicate = find(
            'SELECT * FROM batches WHERE actor=? AND conn=? AND hash=?',
            c.actor,
            c.conn,
            hash,
          )
          if (duplicate) return duplicate
          const id = 'bat_' + randomUUID(),
            a = 'exec_' + randomUUID()
          run(
            "INSERT INTO batches VALUES(?,?,?,?,?,?,?,?,'pending',NULL,0,0,0,0,0)",
            id,
            a,
            c.tenant,
            c.conn,
            c.actor,
            c.revision,
            canon(m),
            hash,
          )
          run(
            "INSERT INTO runs VALUES(?,?,?,?,?,?,?,?, 'pending',?,NULL,?)",
            a,
            c.tenant,
            c.actor,
            c.conn,
            c.op,
            c.key,
            reqHash,
            c.revision,
            seal(
              {
                list: m.list_name,
                list_id: m.list_id,
                rows: m.row_count,
                window: m.window,
                workflows: m.workflows,
                properties: m.properties_allowed,
                manifest_sha256: hash,
                batch_sha256: digest(canon(m.chunk_digests)),
                distinct_attested: m.distinct_attested,
              },
              a + '/preview',
            ),
            Date.now(),
          )
          return byId(id)!
        })
      }
      run(
        'INSERT OR IGNORE INTO batch_keys VALUES(?,?,?,?,?,-1,NULL)',
        c.actor,
        c.conn,
        c.key,
        reqHash,
        b.id,
      )
      const receipt = summary(b, m)
      if (b.state === 'pending')
        return {
          status: 'approval_required',
          execution_id: b.approval,
          approval_url: origin + '/approvals/' + b.approval,
          receipt,
        }
      return {
        status: b.state === 'denied' ? 'refused' : 'confirmed',
        execution_id: b.approval,
        result: receipt,
        receipt,
      }
    }
    const id = z.string().parse(c.args.batch_id),
      b = byId(id)
    if (!b) return denied('chunk_refused:unknown_batch')
    if (prev?.outcome) return { ...JSON.parse(prev.outcome), receipt: { replayed: true } }
    if (prev) return { status: 'ambiguous', execution_id: b.approval }
    const resume = Object.hasOwn(c.args, 'resume')
    if (
      resume &&
      !(b.state === 'halted' && ['ambiguous_halt', 'rate_exhausted'].includes(b.reason))
    )
      return denied('chunk_refused:not_resumable')
    if (!resume && !['approved', 'running'].includes(b.state))
      return denied('chunk_refused:not_approved')
    const m = manifest.parse(JSON.parse(b.manifest))
    if (b.revision !== c.revision || !c.lists.includes(m.list_id))
      return denied('connection_unavailable')
    const until = Date.parse(m.window.expires_at)
    if (Date.now() < Date.parse(m.window.not_before) || Date.now() >= until)
      return denied('chunk_refused:outside_window')
    if (c.args.index !== b.idx) return denied('chunk_refused:wrong_index')
    function halt(reason: string) {
      run(
        "UPDATE batches SET state='halted',reason=? WHERE id=? AND state IN ('approved','running')",
        reason,
        id,
      )
      return denied('chunk_refused:' + reason)
    }
    const parsed = chunk.safeParse(c.args)
    if (!parsed.success) return halt('bad_row')
    const { rows, index } = parsed.data
    if (resume && parsed.data.resume?.snapshot_version !== m.snapshot_version)
      return denied('chunk_refused:attestation_refused')
    if (rows.length !== m.chunk_counts[index]) return halt('count_mismatch')
    if (rows.some((r) => r.source !== undefined && !m.properties_allowed.includes('source')))
      return halt('bad_row')
    if (
      new Set(rows.map((r) => r.email)).size !== rows.length ||
      new Set(rows.map((r) => r.user_id)).size !== rows.length
    )
      return halt('duplicate_in_chunk')
    if (digest(canon(rows)) !== m.chunk_digests[index]) return halt('chunk_mismatch')
    try {
      await workflows(c, m)
      c.reauthorize()
    } catch (e) {
      return halt(fixed(e))
    }
    const claimed = atomic(() => {
      if (Date.now() >= until) return false
      if (resume) {
        const base = find('SELECT * FROM batch_baselines WHERE batch=? AND idx=?', id, index)
        if (
          !base ||
          !run(
            "UPDATE batches SET state='claimed',reason=NULL,sent=?,accepted=?,refused=?,ambiguous=? WHERE id=? AND idx=? AND state='halted' AND reason IN ('ambiguous_halt','rate_exhausted')",
            base.sent,
            base.accepted,
            base.refused,
            base.ambiguous,
            id,
            index,
          ).changes
        )
          return false
        run(
          'UPDATE batch_baselines SET resumes=resumes+1,snapshot=? WHERE batch=? AND idx=?',
          m.snapshot_version,
          id,
          index,
        )
      } else {
        if (
          !run(
            "UPDATE batches SET state='claimed' WHERE id=? AND idx=? AND state IN ('approved','running')",
            id,
            index,
          ).changes
        )
          return false
        run(
          'INSERT INTO batch_baselines VALUES(?,?,?,?,?,?,0,NULL)',
          id,
          index,
          b.sent,
          b.accepted,
          b.refused,
          b.ambiguous,
        )
      }
      run(
        'INSERT INTO batch_keys VALUES(?,?,?,?,?,?,NULL)',
        c.actor,
        c.conn,
        c.key,
        reqHash,
        id,
        index,
      )
      return true
    })
    if (!claimed) return denied('chunk_refused:unsettled_chunk')
    const deadline = Math.min(Date.now() + 120000, until)
    let reason: string | null = null
    for (const row of rows) {
      try {
        const value = await http(c, 'contacts/update', deadline, {
          email: row.email,
          userId: row.user_id,
          mailingLists: { [m.list_id]: true },
          ...(row.source !== undefined ? { source: row.source } : {}),
        })
        if (
          value?.success !== true ||
          typeof value.id !== 'string' ||
          !/^[A-Za-z0-9_-]{1,200}$/.test(value.id)
        )
          throw Error('ambiguous_halt')
        run('UPDATE batches SET sent=sent+1,accepted=accepted+1 WHERE id=?', id)
      } catch (e) {
        reason = fixed(e)
        const definite = ['loops_refused', 'credential_refused'].includes(reason)
        run(
          'UPDATE batches SET sent=sent+1,refused=refused+?,ambiguous=ambiguous+? WHERE id=?',
          Number(definite),
          Number(!definite),
          id,
        )
        break
      }
    }
    return atomic(() => {
      const state = reason ? 'halted' : index + 1 === m.chunk_count ? 'done' : 'running'
      run(
        'UPDATE batches SET idx=idx+?,state=?,reason=? WHERE id=?',
        reason ? 0 : 1,
        state,
        reason,
        id,
      )
      const result = summary(byId(id)!, m),
        answer = {
          status: reason
            ? ['credential_refused', 'loops_refused'].includes(reason)
              ? 'refused'
              : 'ambiguous'
            : 'confirmed',
          execution_id: b.approval,
          result,
        }
      run(
        'UPDATE batch_keys SET outcome=? WHERE actor=? AND conn=? AND idem=?',
        JSON.stringify(answer),
        c.actor,
        c.conn,
        c.key,
      )
      return answer
    })
  }
}
