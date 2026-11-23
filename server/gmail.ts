import { z } from 'zod'
import { createHash } from 'node:crypto'
const input = z
  .object({
    label_id: z.string().min(1).max(200),
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }),
    cursor: z.string().max(1000).nullable().optional(),
    page_size: z.number().int().min(1).max(50).default(10),
    maximum_bytes: z.number().int().min(1).max(7000000).default(4000000),
  })
  .strict()
export class GmailError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
  }
}
const invalid = () => new GmailError('REQUEST_REFUSED', 'gmail_response_invalid')
export async function gmailPage(
  args: Record<string, unknown>,
  labels: string[],
  token: string,
  send: typeof fetch,
) {
  const q = input.safeParse(args)
  if (!q.success) throw new GmailError('REQUEST_REFUSED', 'Gmail request is invalid')
  const { label_id, starts_at, ends_at, maximum_bytes, page_size } = q.data
  const start = Date.parse(starts_at),
    end = Date.parse(ends_at)
  if (start >= end) throw new GmailError('REQUEST_REFUSED', 'Gmail request is invalid')
  if (!labels.includes(label_id))
    throw new GmailError('BUSINESS_RESOURCE_UNAVAILABLE', 'Selected Gmail label is unavailable')
  const prefix = 'op-gmail-page-v1:',
    window = createHash('sha256')
      .update(JSON.stringify([label_id, start, end]))
      .digest('hex')
  let page = q.data.cursor ?? null,
    offset = 0,
    size = page_size,
    anchor = ''
  if (page?.startsWith(prefix)) {
    try {
      const c = z
        .object({
          page: z.string().nullable(),
          offset: z.number().int().min(0),
          size: z.number().int().min(1).max(50),
          anchor: z.string().min(1),
          window: z.literal(window),
        })
        .strict()
        .parse(JSON.parse(Buffer.from(page.slice(prefix.length), 'base64url').toString()))
      if (c.offset >= c.size) throw Error()
      ;({ page, offset, size, anchor } = c)
    } catch {
      throw new GmailError('REQUEST_REFUSED', 'gmail_continuation_invalid')
    }
  }
  const deadline = AbortSignal.timeout(60000)
  async function read(path: string, query: Record<string, string>, missing: string) {
    const u = new URL('https://www.googleapis.com/gmail/v1/users/me/messages' + path)
    u.search = new URLSearchParams(query).toString()
    const r = await send(u, {
      headers: { Authorization: 'Bearer ' + token },
      redirect: 'error',
      signal: deadline,
    })
    if (!r.ok) {
      await r.body?.cancel()
      if (r.status === 401)
        throw new GmailError('CONNECTION_REPAIR_REQUIRED', 'Reconnect Google in OpenPassword')
      if (r.status === 404)
        throw new GmailError(path ? 'REQUEST_REFUSED' : 'BUSINESS_RESOURCE_UNAVAILABLE', missing)
      if (r.status === 429) throw new GmailError('RATE_LIMITED', 'Gmail rate limit reached')
      if (r.status >= 500)
        throw new GmailError('PROVIDER_UNAVAILABLE', 'Gmail is temporarily unavailable')
      throw new GmailError('REQUEST_REFUSED', 'Gmail request refused')
    }
    const reader = r.body?.getReader(),
      parts: Buffer[] = []
    let length = 0
    if (reader)
      for (;;) {
        const value = await reader.read()
        if (value.done) break
        length += value.value.length
        if (length > 36000000) {
          await reader.cancel()
          throw invalid()
        }
        parts.push(Buffer.from(value.value))
      }
    return JSON.parse(Buffer.concat(parts).toString())
  }
  const listing = await read(
    '',
    {
      labelIds: label_id,
      q: 'after:' + (Math.floor(start / 1000) - 1) + ' before:' + (Math.floor(end / 1000) + 1),
      maxResults: String(size),
      includeSpamTrash: 'false',
      ...(page ? { pageToken: page } : {}),
    },
    'Selected Gmail label is unavailable',
  )
  const rows = z
    .array(z.object({ id: z.string().regex(/^[\w-]{1,200}$/) }))
    .max(size)
    .parse(listing.messages ?? [])
  let next: string | null =
    listing.nextPageToken == null ? null : z.string().min(1).max(1000).parse(listing.nextPageToken)
  if (next && next === page) throw invalid()
  if (anchor && rows[offset]?.id !== anchor)
    throw new GmailError('REQUEST_REFUSED', 'gmail_continuation_stale')
  const messages = [],
    skipped = []
  let bytes = 0,
    outside = 0,
    listed = 0
  for (let i = offset; i < rows.length; i++) {
    const id = rows[i].id
    function resume() {
      const cursor =
        prefix +
        Buffer.from(JSON.stringify({ page, offset: i, size, anchor: id, window })).toString(
          'base64url',
        )
      if (cursor.length > 1000)
        throw new GmailError('REQUEST_REFUSED', 'gmail_continuation_oversize')
      return cursor
    }
    if (listed === page_size) {
      next = resume()
      break
    }
    const m = await read('/' + id, { format: 'raw' }, 'gmail_continuation_stale')
    if (m.id !== id || typeof m.threadId !== 'string' || !Array.isArray(m.labelIds)) throw invalid()
    if (!m.labelIds.includes(label_id))
      throw new GmailError('REQUEST_REFUSED', 'gmail_continuation_stale')
    const at = Number(m.internalDate)
    if (!Number.isSafeInteger(at)) throw invalid()
    if (at < start || at >= end) {
      outside++
      listed++
      continue
    }
    if (typeof m.raw !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(m.raw)) throw invalid()
    const raw = Buffer.from(m.raw, 'base64url')
    if (raw.length > maximum_bytes) {
      skipped.push({ id, size: raw.length, reason: 'oversized', at: new Date().toISOString() })
      listed++
      continue
    }
    if (bytes + raw.length > maximum_bytes) {
      next = resume()
      break
    }
    bytes += raw.length
    listed++
    messages.push({
      id,
      thread_id: m.threadId,
      internal_date_ms: at,
      raw_base64: raw.toString('base64'),
    })
  }
  return {
    schema_version: 2,
    label_id,
    messages,
    skipped,
    next_cursor: next,
    complete: next === null,
    consistency: 'best_effort',
    counts: { listed, retained: messages.length, skipped: skipped.length, outside_window: outside },
  }
}
