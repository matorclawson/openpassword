import { createHash } from 'node:crypto'
type ThreadPost = {
  text: string
  media_ids?: readonly string[]
  reply_to_prior_index: number | null
}
export type ThreadStep = { index: number; request_digest: string; returned_id: string | null }
const canonical = (value: unknown) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  )
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const providerId = (id: string) =>
  typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id) && BigInt(id) <= 18446744073709551615n
/** Exact preview and chained request digests for an approved X thread. */
export function xThread(account_id: string, inputs: readonly ThreadPost[]) {
  if (!providerId(account_id) || !Array.isArray(inputs) || inputs.length < 1 || inputs.length > 25)
    throw Error('THREAD_VALUE')
  const posts = inputs.map((p: ThreadPost, index: number) => {
    const media_ids = [...(p.media_ids ?? [])]
    if (
      typeof p.text !== 'string' ||
      Array.from(p.text).length > 280 ||
      /[\uD800-\uDFFF]/u.test(p.text) ||
      (!p.text.trim() && !media_ids.length) ||
      media_ids.length > 4 ||
      media_ids.some((id) => !providerId(id) || id.length > 19) ||
      new Set(media_ids).size !== media_ids.length
    )
      throw Error('THREAD_VALUE')
    if (p.reply_to_prior_index !== (index === 0 ? null : index - 1))
      throw Error('THREAD_REPLY_LINK')
    return { text: p.text, media_ids, reply_to_prior_index: p.reply_to_prior_index }
  })
  const rendering = canonical({ account_id, posts, provider: 'x', version: 1 })
  if (Buffer.byteLength(rendering) > 6000) throw Error('THREAD_PREVIEW_LIMIT')
  const thread_digest = digest(rendering)
  function request(index: number, prior: readonly ThreadStep[]) {
    const p = posts[index]
    const body = {
      text: p.text,
      ...(p.media_ids.length ? { media: { media_ids: [...p.media_ids] } } : {}),
      ...(index ? { reply: { in_reply_to_tweet_id: prior[index - 1].returned_id } } : {}),
    }
    const request_digest = digest(
      canonical({
        thread_digest,
        index,
        account_id,
        provider: 'x',
        method: 'POST',
        path: '/2/tweets',
        body,
      }),
    )
    return {
      operation_id: 'x.publish',
      arguments: body,
      step: { index, request_digest, returned_id: null } as ThreadStep,
    }
  }
  return {
    rendering,
    digest: thread_digest,
    next(prior: readonly ThreadStep[]) {
      if (prior.length > posts.length) throw Error('THREAD_STATE')
      for (const [i, s] of prior.entries()) {
        if (s.index !== i || s.request_digest !== request(i, prior).step.request_digest)
          throw Error('THREAD_REQUEST_BINDING')
        if (
          s.returned_id === null ||
          s.returned_id === 'UNKNOWN' ||
          (providerId(s.returned_id) && s.returned_id.length > 19)
        ) {
          if (i !== prior.length - 1) throw Error('THREAD_STATE')
          return null
        }
        if (!providerId(s.returned_id)) throw Error('THREAD_STATE')
      }
      return prior.length === posts.length ? null : request(prior.length, prior)
    },
  }
}
