import {
  revolutAccounts,
  revolutTransactions,
  expenseResult,
} from '../packages/connectors/revolut.ts'
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
    case 'revolut.expenses.list':
    case 'revolut.expenses.get':
    case 'revolut.labels.list':
    case 'revolut.label_groups.list':
      return expenseResult(op, data, args)
    case 'revolut.business.accounts.list':
      return revolutAccounts(data)
    case 'revolut.business.transactions.read_page':
      return revolutTransactions(data, args)
    case 'threads.status':
    case 'instagram.status': {
      const status = data?.status_code ?? data?.status
      if (typeof status !== 'string') throw Error('Container status missing')
      return { ...data, provider_status: status }
    }
    case 'tiktok.creator_info':
    case 'tiktok.inbox':
    case 'tiktok.publish':
    case 'tiktok.status': {
      if (data?.error?.code !== 'ok' || !data.data) throw Error('TikTok operation refused')
      if (op === 'tiktok.creator_info') return data.data
      if (op !== 'tiktok.status')
        return { publish_id: z.string().min(1).parse(data.data.publish_id), stage: 'processing' }
      const status = z.string().parse(data.data.status)
      const stage = (
        {
          SEND_TO_USER_INBOX: 'inbox_delivered',
          PUBLISH_COMPLETE: 'published',
          PROCESSING_UPLOAD: 'processing',
          PROCESSING_DOWNLOAD: 'processing',
          FAILED: 'failed',
        } as Record<string, string>
      )[status]
      if (!stage) throw Error('Unknown TikTok state')
      return { stage, provider_status: status, publish_id: args.publish_id }
    }
    case 'x.publish':
      if (!/^\d{1,20}$/.test(data?.data?.id ?? '')) throw Error('Missing X publication ID')
      return { ...data, post_id: data.data.id, stage: 'published' }
    case 'facebook.post':
    case 'instagram.publish':
    case 'threads.publish':
    case 'mastodon.publish':
      if (typeof data?.id !== 'string' || !data.id) throw Error('Missing publication ID')
      return { ...data, post_id: data.id, stage: 'published' }
    case 'threads.draft':
    case 'instagram.media.create':
      if (typeof data?.id !== 'string' || !data.id) throw Error('Missing container ID')
      return { ...data, container_id: data.id }
    default:
      return data
  }
}
