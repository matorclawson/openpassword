import { createHmac, timingSafeEqual, createHash } from 'node:crypto'
function equal(left: Buffer, right: Buffer) {
  return left.length === right.length && timingSafeEqual(left, right)
}
export function verifyLoopsWebhook(
  body: Buffer,
  headers: { id: string; timestamp: string; signature: string },
  secrets: string[],
  time = Math.floor(Date.now() / 1000),
) {
  const { id, timestamp, signature } = headers
  if (
    body.length > 1048576 ||
    !/^[-A-Za-z0-9_]{1,200}$/.test(id) ||
    !/^\d{1,16}$/.test(timestamp) ||
    Math.abs(time - Number(timestamp)) > 300 ||
    signature.length > 8192 ||
    secrets.length > 8
  )
    throw Error('Webhook refused')
  const signed = Buffer.concat([Buffer.from(id + '.' + timestamp + '.'), body])
  const candidates = signature
    .split(/\s+/)
    .filter((s) => /^v1,[A-Za-z0-9+/]{43}=$/.test(s))
    .map((s) => Buffer.from(s.slice(3), 'base64'))
  let valid = false
  for (const encoded of secrets) {
    const key = Buffer.from(encoded.replace(/^whsec_/, ''), 'base64')
    if (!key.length) continue
    const expected = createHmac('sha256', key).update(signed).digest()
    for (const value of candidates) valid = equal(expected, value) || valid
  }
  if (!valid) throw Error('Webhook refused')
  return {
    webhook_id: id,
    timestamp: Number(timestamp),
    body_sha256: createHash('sha256').update(body).digest('hex'),
  }
}
export function verifyTwilioWebhook(
  url: string,
  form: URLSearchParams,
  signature: string,
  token: string,
) {
  if (!token || !/^https:\/\//.test(url) || !/^[-A-Za-z0-9+/]{27}=$/.test(signature)) return false
  const keys = Array.from(form.keys()).sort()
  if (new Set(keys).size !== keys.length) return false
  const message = url + keys.map((k) => k + form.get(k)).join('')
  return equal(createHmac('sha1', token).update(message).digest(), Buffer.from(signature, 'base64'))
}
