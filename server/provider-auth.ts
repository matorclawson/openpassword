import { createSign } from 'node:crypto'
import { z } from 'zod'
export async function scopedToken(
  provider: string,
  stored: string,
  send: typeof fetch,
): Promise<string> {
  // Raw provider tokens remain valid input for accounts enrolled before these adapters.
  if (
    !stored.trimStart().startsWith('{') ||
    !['github_read', 'reddit_read', 'bluesky'].includes(provider)
  )
    return stored
  const config = JSON.parse(stored)
  const post = async (url: string, headers: Record<string, string>, body: string) => {
    const res = await send(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      await res.body?.cancel()
      throw Error('Provider authentication refused')
    }
    return res.json()
  }
  if (provider === 'reddit_read') {
    const b = z
      .object({
        client_id: z.string().min(1).max(200),
        client_secret: z.string().min(1).max(500),
        user_agent: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[ -~]+$/),
      })
      .strict()
      .parse(config)
    const result = await post(
      'https://www.reddit.com/api/v1/access_token',
      {
        Authorization:
          'Basic ' + Buffer.from(b.client_id + ':' + b.client_secret).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': b.user_agent,
      },
      'grant_type=client_credentials',
    )
    return z
      .object({ access_token: z.string().min(1), token_type: z.string().regex(/^bearer$/i) })
      .parse(result).access_token
  }
  if (provider === 'bluesky') {
    const b = z
      .object({ identifier: z.string().min(1), app_password: z.string().min(1) })
      .strict()
      .parse(config)
    const result = await post(
      'https://bsky.social/xrpc/com.atproto.server.createSession',
      { 'Content-Type': 'application/json' },
      JSON.stringify({ identifier: b.identifier, password: b.app_password }),
    )
    return z.object({ accessJwt: z.string().min(1) }).parse(result).accessJwt
  }
  const app = z
    .object({
      app_id: z.string().regex(/^\d+$/),
      installation_id: z.string().regex(/^\d+$/),
      private_key: z.string().min(1),
      repository_ids: z.array(z.number().int().positive()).min(1).max(500),
    })
    .strict()
    .parse(config)
  const time = Math.floor(Date.now() / 1000),
    enc = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const unsigned =
    enc({ alg: 'RS256', typ: 'JWT' }) +
    '.' +
    enc({ iat: time - 60, exp: time + 540, iss: app.app_id })
  const jwt =
    unsigned + '.' + createSign('RSA-SHA256').update(unsigned).sign(app.private_key, 'base64url')
  const result = await post(
    'https://api.github.com/app/installations/' + app.installation_id + '/access_tokens',
    {
      Authorization: 'Bearer ' + jwt,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'OpenPassword/0.1',
    },
    JSON.stringify({
      repository_ids: app.repository_ids,
      permissions: { contents: 'read', metadata: 'read', issues: 'read', pull_requests: 'read' },
    }),
  )
  return z.object({ token: z.string().min(1) }).parse(result).token
}
