import { randomUUID, createHash } from 'node:crypto'
const gitOps = [
  'github.repos.search',
  'github.repo.get',
  'github.releases.list',
  'github.release.latest',
  'github.readme.get',
]
export const sourceOperation = (id: string) => gitOps.includes(id) || id === 'reddit.subreddit.new'
export class ReadFailure extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
  }
}
const hex = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
export async function readSource(
  op: string,
  url: URL,
  headers: Record<string, string>,
  send: typeof fetch,
  requestHash: string,
  reserve: () => void,
  hold: (until: number) => void,
) {
  const origin = url.origin,
    requested = url.href,
    deadline = AbortSignal.timeout(20000)
  for (let hop = 0; hop <= 3; hop++) {
    reserve()
    const r = await send(url, { headers, redirect: 'manual', signal: deadline })
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const location = r.headers.get('location')
      await r.body?.cancel()
      if (!location) throw new ReadFailure('REQUEST_REFUSED', 'redirect refused')
      url = new URL(location, url)
      if (url.origin !== origin || url.username || url.password)
        throw new ReadFailure('REQUEST_REFUSED', 'redirect refused')
      continue
    }
    if (r.status === 429) {
      const secs = Number(r.headers.get('retry-after') || 60)
      hold(Date.now() + 1000 * Math.min(86400, Math.max(1, Number.isFinite(secs) ? secs : 60)))
      await r.body?.cancel()
      throw new ReadFailure('RATE_LIMITED', 'provider read window spent')
    }
    if (!r.ok && ![404, 410, 422, 451].includes(r.status)) {
      await r.body?.cancel()
      throw new ReadFailure(
        [401, 403].includes(r.status) ? 'CONNECTION_REPAIR_REQUIRED' : 'PROVIDER_UNAVAILABLE',
        'read refused',
      )
    }
    const reader = r.body?.getReader(),
      parts: Buffer[] = []
    let len = 0
    if (reader)
      for (;;) {
        const v = await reader.read()
        if (v.done) break
        len += v.value.length
        if (len > 1048576) {
          await reader.cancel()
          throw new ReadFailure('REQUEST_REFUSED', 'answer exceeds size cap')
        }
        parts.push(Buffer.from(v.value))
      }
    const bytes = Buffer.concat(parts),
      value = JSON.parse(bytes.toString())
    if (
      value?.private ||
      value?.items?.some((x: { private?: boolean }) => x.private) ||
      value?.data?.children?.some((x: { data?: { subreddit_type?: string } }) =>
        ['private', 'employees_only', 'gold_only', 'quarantined'].includes(
          x.data?.subreddit_type || '',
        ),
      )
    )
      throw new ReadFailure('REQUEST_REFUSED', 'private source refused')
    const chosen = [
      'content-type',
      'link',
      'retry-after',
      'etag',
      'last-modified',
      'x-ratelimit-reset',
      'x-ratelimit-remaining',
    ]
    const acquired = new Date().toISOString(),
      github = gitOps.includes(op)
    return {
      observation_ref: (github ? 'github-read-' : 'reddit-read-') + randomUUID(),
      observed_at: acquired,
      acquired_at: acquired,
      operation_id: op,
      connector_revision: github ? 'github_read.sources@1' : 'reddit_read.sources@1',
      request_sha256: requestHash,
      requested_url: requested,
      final_url: url.href,
      status: r.status,
      body_base64: bytes.toString('base64'),
      body_bytes: len,
      body_sha256: hex(bytes),
      complete: true,
      size_cap_bytes: 1048576,
      headers: Object.fromEntries(
        chosen.filter((n) => r.headers.has(n)).map((n) => [n, r.headers.get(n)]),
      ),
      retention: 'transient',
    }
  }
  throw new ReadFailure('REQUEST_REFUSED', 'too many redirects')
}
