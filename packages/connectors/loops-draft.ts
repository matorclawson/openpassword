import { z } from 'zod'
const id = z.string().regex(/^[\w-]{1,80}$/)
const line = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\p{C}\p{Zl}\p{Zp}\u115f\u1160\u3164\uffa0\u034f\u2800\ufe00-\ufe0f]/u.test(s))
const op = z.enum([
  'contains',
  'notContains',
  'equals',
  'notEquals',
  'greaterThan',
  'lessThan',
  'isTrue',
  'isFalse',
  'empty',
  'notEmpty',
])
const condition = z.union([
  z
    .object({
      type: z.literal('property'),
      key: line(60).min(1),
      operator: op,
      value: z.union([line(100), z.number()]).optional(),
    })
    .strict()
    .refine(
      (v) =>
        ['isTrue', 'isFalse', 'empty', 'notEmpty'].includes(v.operator) === (v.value === undefined),
    ),
  z
    .object({ type: z.literal('optIn'), status: z.enum(['accepted', 'pending', 'rejected']) })
    .strict(),
])
export const loopEffects = [
  'loops.newsletter.update_email_message',
  'loops.newsletter.update_campaign_audience',
  'loops.newsletter.create_upload',
  'loops.newsletter.complete_upload',
]
export function loopsDraftBody(operation: string, raw: unknown) {
  if (operation === loopEffects[0]) {
    const b = z
      .object({
        email_message_id: id,
        expected_revision_id: id,
        campaign_id: id,
        subject: line(200),
        preview_text: line(200),
        from_name: line(100),
        from_email: z.string().regex(/^[a-zA-Z0-9._+-]{1,64}$/),
        lmx: z
          .string()
          .min(1)
          .refine((s) => Buffer.byteLength(s) <= 60000),
      })
      .strict()
      .parse(raw)
    return {
      expectedRevisionId: b.expected_revision_id,
      subject: b.subject,
      previewText: b.preview_text,
      fromName: b.from_name,
      fromEmail: b.from_email,
      lmx: b.lmx,
    }
  }
  if (operation === loopEffects[1]) {
    const b = z
      .object({
        campaign_id: id,
        mailing_list_id: id.optional(),
        audience_segment_id: id.optional(),
        audience_filter: z
          .object({ match: z.enum(['all', 'any']), conditions: z.array(condition).min(1).max(20) })
          .strict()
          .optional(),
      })
      .strict()
      .refine((v) => !!(v.mailing_list_id || v.audience_segment_id || v.audience_filter))
      .parse(raw)
    return {
      ...(b.mailing_list_id ? { mailingListId: b.mailing_list_id } : {}),
      ...(b.audience_segment_id ? { audienceSegmentId: b.audience_segment_id } : {}),
      ...(b.audience_filter ? { audienceFilter: b.audience_filter } : {}),
    }
  }
  if (operation === loopEffects[2]) {
    const b = z
      .object({
        content_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
        content_length: z.number().int().min(1).max(4000000),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .parse(raw)
    return { contentType: b.content_type, contentLength: b.content_length }
  }
  z.object({ email_asset_id: id }).strict().parse(raw)
  return {}
}
