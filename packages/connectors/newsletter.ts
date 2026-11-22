import { z } from 'zod'
const text = z.string().trim().min(1)
const kitId = z.number().int().positive()
const unique = <T>(v: T[]) => new Set(v).size === v.length
const filter = z
  .object({ type: z.enum(['tag', 'segment']), ids: z.array(kitId).min(1).max(1000).refine(unique) })
  .strict()
const kitAudience = z
  .object({
    mode: z.enum(['all', 'any', 'none']).default('all'),
    filters: z.array(filter).max(2).default([]),
    entire_account: z.boolean().default(false),
  })
  .strict()
  .refine(
    (a) =>
      (a.entire_account ? a.mode === 'all' && !a.filters.length : a.filters.length > 0) &&
      unique(a.filters.map((f) => f.type)),
  )
const kit = z
  .object({
    subject: text,
    content: text,
    email_address: z.email(),
    email_template_id: kitId,
    audience: kitAudience,
    description: z.string().default(''),
    preview_text: z.string().default(''),
    published_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
const identifier = z.string().trim().min(1)
const ids = (n: number) => z.array(identifier).max(n).refine(unique).default([])
const audience = z
  .object({
    contact_ids: ids(1000),
    list_ids: ids(100),
    exclude_contact_ids: ids(1000),
    exclude_list_ids: ids(100),
  })
  .strict()
  .refine(
    (a) =>
      !a.contact_ids.some((id) => a.exclude_contact_ids.includes(id)) &&
      !a.list_ids.some((id) => a.exclude_list_ids.includes(id)),
  )
const record = z.record(z.string(), z.unknown())
const hub = z
  .object({
    name: text,
    subject: text,
    from_name: text,
    from_email: z.email(),
    reply_to: z.email().nullish(),
    kind: z.literal('newsletter').default('newsletter'),
    audience: audience.optional(),
    content: z
      .object({
        template_path: text.nullish(),
        plain_text: text.nullish(),
        widgets: record.optional(),
        flex_areas: record.optional(),
      })
      .strict(),
    subscription_id: identifier.nullish(),
    office_location_id: identifier.nullish(),
    campaign_id: identifier.nullish(),
    business_unit_id: z.number().int().min(0).nullish(),
  })
  .strict()
export function buildDraft(provider: 'kit' | 'hubspot', value: unknown) {
  if (provider === 'kit') {
    const d = kit.parse(value)
    return {
      subject: d.subject,
      content: d.content,
      email_address: d.email_address,
      email_template_id: d.email_template_id,
      description: d.description,
      preview_text: d.preview_text,
      published_at: d.published_at ?? new Date().toISOString(),
      send_at: null,
      public: false,
      thumbnail_alt: null,
      thumbnail_url: null,
      subscriber_filter: d.audience.entire_account
        ? []
        : [{ [d.audience.mode]: d.audience.filters }],
    }
  }
  const d = hub.parse(value),
    a = d.audience ?? audience.parse({}),
    c = d.content
  const details = {
    ...(d.subscription_id ? { subscriptionId: d.subscription_id } : {}),
    ...(d.office_location_id ? { officeLocationId: d.office_location_id } : {}),
  }
  return {
    name: d.name,
    subject: d.subject,
    from: {
      fromName: d.from_name,
      replyTo: d.from_email,
      ...(d.reply_to ? { customReplyTo: d.reply_to } : {}),
    },
    content: {
      ...(c.template_path ? { templatePath: c.template_path } : {}),
      ...(c.plain_text ? { plainTextVersion: c.plain_text } : {}),
      ...(c.widgets && Object.keys(c.widgets).length ? { widgets: c.widgets } : {}),
      ...(c.flex_areas && Object.keys(c.flex_areas).length ? { flexAreas: c.flex_areas } : {}),
    },
    to: {
      contactIds: { include: a.contact_ids, exclude: a.exclude_contact_ids },
      contactIlsLists: { include: a.list_ids, exclude: a.exclude_list_ids },
      suppressGraymail: true,
      limitSendFrequency: true,
    },
    sendOnPublish: false,
    state: 'DRAFT',
    subcategory: 'batch',
    ...(Object.keys(details).length ? { subscriptionDetails: details } : {}),
    ...(d.campaign_id ? { campaign: d.campaign_id } : {}),
    ...(d.business_unit_id != null ? { businessUnitId: d.business_unit_id } : {}),
  }
}
