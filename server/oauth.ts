import { createHash } from 'node:crypto'
import { z } from 'zod'
export const oauthConfig = z.object({
  client_id: z.string().min(1).max(500),
  client_secret: z.string().min(1).max(2000),
  resources: z.array(z.string().min(1).max(200)).max(100).optional(),
  scope: z.enum([
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/youtube.readonly',
  ]),
  label: z.string().min(1).max(200),
})
export function authorize(
  client: string,
  scope: string,
  state: string,
  verifier: string,
  callback: string,
) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({
    client_id: client,
    scope: 'openid email ' + scope,
    state,
    redirect_uri: callback,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }).toString()
  return url.href
}
export async function exchange(fields: Record<string, string>, send: typeof fetch) {
  const res = await send('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams(fields),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw Error('OAuth exchange refused')
  return z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().optional(),
      expires_in: z.number().positive(),
    })
    .parse(await res.json())
}
