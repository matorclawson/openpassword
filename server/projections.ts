import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
const dec = (text: string) => createHash('sha256').update(text).digest('hex')
export function project(op: string, data: any, args: Record<string, unknown>) {
  const timestamp = new Date().toISOString()
  switch (op) {
    case 'loops.newsletter.inspect_account':
      if (data.success !== true || typeof data.teamName !== 'string') throw Error('Invalid account')
      return {
        observation_ref: 'loops-observation-' + randomUUID(),
        observed_at: timestamp,
        team_name: data.teamName,
        key_valid: true,
      }
    case 'loops.newsletter.get_campaign':
      if (data.id !== args.campaign_id) throw Error('Campaign mismatch')
      return { campaign: data }
    case 'loops.newsletter.get_email_message':
      if (data.id !== args.email_message_id) throw Error('Message mismatch')
      return { email_message: { ...data, lmx_sha256: data.lmx == null ? null : dec(data.lmx) } }
    case 'loops.newsletter.list_mailing_lists':
      return { mailing_lists: data }
    case 'loops.newsletter.list_themes':
      return { themes: data }
    case 'loops.newsletter.create_campaign':
      if (data.status !== 'Draft' || typeof data.id !== 'string')
        throw Error('Draft state unconfirmed')
      return {
        provider: 'loops',
        operation: 'create_campaign',
        delivery_state: 'draft',
        publication_authorization: 'not_authorized',
        remote_id: data.id,
        email_message_id: data.emailMessageId,
        email_message_content_revision_id: data.emailMessageContentRevisionId,
      }
    case 'kit.subscribers.read_page': {
      const cursor = data.pagination?.has_next_page
        ? z.string().min(1).parse(data.pagination?.end_cursor)
        : null
      const records = z
        .array(
          z.object({
            id: z.union([z.number(), z.string()]),
            email_address: z.string().optional(),
            state: z.string().optional(),
            created_at: z.string().optional(),
          }),
        )
        .max(100)
        .parse(data.subscribers)
      return {
        observation_ref: 'kit-subscribers-' + randomUUID(),
        observed_at: timestamp,
        subscribers: records,
        count: records.length,
        next_after: cursor,
        last_page: cursor === null,
        retention: 'transient',
      }
    }
    case 'revolut.business.accounts.list':
      return { accounts: data }
    case 'revolut.business.transactions.read_page': {
      if (!Array.isArray(data)) throw Error('Invalid page')
      const count = Number(args.count ?? 100)
      const dates = data.map((r) => Date.parse(r.created_at))
      if (dates.some((d) => !Number.isFinite(d))) throw Error('Invalid timestamp')
      const next = data.length === count ? new Date(Math.min(...dates)).toISOString() : null
      if (next && args.to && Date.parse(next) >= Date.parse(String(args.to)))
        throw Error('Continuation stalled')
      return {
        transactions: data,
        observed_at: timestamp,
        next_to: next,
        normalization_version: 'revolut-business-read-1',
      }
    }
    default:
      return data
  }
}
