import { templatePreview, templateOps } from './template-preview.ts'
import { digest } from './store.ts'
type Row = Record<string, any>
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c]!,
  )
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v))
export function snapshotDigest(v: unknown) {
  return (
    'sha256:' +
    digest(
      JSON.stringify(v, (_, x) =>
        x && typeof x === 'object' && !Array.isArray(x)
          ? Object.fromEntries(
              Object.keys(x)
                .sort()
                .map((k) => [k, x[k]]),
            )
          : x,
      ),
    )
  )
}
export function approvalSnapshot(
  op: string,
  args: Row,
  device: { device_id: string; device_name: string; application_id: string | null },
  verifiedUrl: string | null = null,
) {
  if (templateOps.includes(op)) return templatePreview(op, args, device)
  if (
    ![
      'kit.newsletter.create_draft',
      'hubspot.newsletter.create_draft',
      'hubspot.newsletter.update_draft',
    ].includes(op)
  )
    return null
  const d = args.draft ?? {},
    kit = op.startsWith('kit.'),
    c = d.content ?? {}
  let truncated = false,
    visits = 0,
    remaining = 14500
  function cut(v: unknown, n = 2000): string | null {
    if (v == null) return null
    const str = String(v)
      .replace(/[\u2028\u2029\u0085\r\v\f\u001c-\u001f]/gu, ' ')
      .replace(
        /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2065\u3164\ufe00-\ufe0f\uffa0\ufff0-\ufff8\u{e0000}-\u{e0fff}]/gu,
        (ch) => (ch === '\n' || ch === '\t' ? ch : ''),
      )
    let out = '',
      size = 0
    for (const ch of str) {
      size += bytes(ch) - 2
      if (size > n) {
        truncated = true
        break
      }
      out += ch
    }
    return out
  }
  const fields: Row = kit
    ? {
        subject: cut(d.subject),
        email_address: cut(d.email_address, 320),
        email_template_id: cut(d.email_template_id, 40),
        preview_text: cut(d.preview_text),
        description: cut(d.description),
        published_at: cut(d.published_at, 40),
      }
    : {
        name: cut(d.name, 200),
        subject: cut(d.subject),
        from_name: cut(d.from_name, 200),
        from_email: cut(d.from_email, 320),
        reply_to: cut(d.reply_to, 320),
        template_path: cut(c.template_path, 300),
        kind: cut(d.kind, 40),
        subscription_id: cut(d.subscription_id, 40),
        office_location_id: cut(d.office_location_id, 40),
        campaign_id: cut(d.campaign_id, 40),
        business_unit_id: cut(d.business_unit_id, 40),
      }
  const names = (value: object) => {
    const keys = Object.keys(value).sort()
    if (keys.length > 50) truncated = true
    return keys.slice(0, 50).map((k) => cut(k, 80))
  }
  const widgets: Row[] = []
  const content = {
    plain_text: cut(kit ? d.content : c.plain_text),
    text_format: kit ? 'html_source' : 'text',
    widgets,
    flex_area_keys: kit ? [] : names(c.flex_areas ?? {}),
  }
  const target = {
    creation_execution_id: cut(args.creation_execution_id, 220),
    draft_url:
      verifiedUrl &&
      /^https:\/\/(app|app-eu1)\.hubspot\.com\/email\/\d+\/edit\/\d+\/content$/.test(verifiedUrl)
        ? verifiedUrl
        : null,
  }
  const shape = {
    schema: 'approval-snapshot/1',
    kind: 'newsletter_draft',
    provider: kit ? 'kit' : 'hubspot',
    operation: op,
    fields,
    content,
    audience: {
      change: Object.hasOwn(d, 'audience') ? (kit ? 'specified' : 'replaced') : 'unchanged',
      summary: null,
    },
    target,
    requested_by: { ...device, device_name: cut(device.device_name, 200) ?? '' },
    limits: { truncated },
  }
  remaining = Math.max(0, 16384 - bytes(shape) - 512)
  const raw = kit ? {} : (c.widgets ?? {}),
    keys = Object.keys(raw).sort()
  if (keys.length > 40) truncated = true
  for (const key of keys.slice(0, 40)) {
    remaining -=
      120 + bytes(cut(key, 100) ?? '') + Array.from(String(raw[key]?.module_id ?? '')).length
    if (remaining < 0) {
      truncated = true
      break
    }
    const w = raw[key],
      items: Row[] = []
    let omitted = false
    function walk(v: any, path: string, leaf: string, depth: number) {
      if (++visits > 2000 || items.length >= 60 || remaining < 120) {
        omitted = truncated = true
        return
      }
      let item: Row
      if (v && typeof v === 'object' && depth < 4) {
        const keys = Array.isArray(v) ? v.map((_, i) => String(i)) : Object.keys(v).sort()
        for (const k of keys) {
          if (items.length >= 60 || visits >= 2000 || remaining < 120) {
            omitted = truncated = true
            break
          }
          walk(
            v[k],
            cut(Array.isArray(v) ? path + '[' + k + ']' : path ? path + '.' + k : k, 200)!,
            Array.isArray(v) ? leaf : k,
            depth + 1,
          )
        }
        return
      }
      if (v == null || typeof v === 'boolean' || typeof v === 'object') {
        item = {
          path,
          kind: 'other',
          field_names: v && typeof v === 'object' && !Array.isArray(v) ? names(v) : [],
        }
        if (v && typeof v === 'object') omitted = truncated = true
      } else {
        const kind =
          typeof v !== 'string'
            ? 'other'
            : /src|image|img/i.test(leaf)
              ? 'image'
              : /href|url|link/i.test(leaf)
                ? 'link'
                : 'text'
        const value = cut(v),
          clipped = bytes(v) > 2002
        if (clipped) omitted = true
        item = {
          path,
          kind,
          truncated: clipped,
          [kind === 'link' ? 'href' : kind === 'image' ? 'src' : 'text']: value,
        }
      }
      remaining -=
        120 +
        Object.values(item).reduce<number>(
          (sum, val) =>
            sum +
            (typeof val === 'string'
              ? bytes(val)
              : Array.isArray(val)
                ? val.reduce((n, x) => n + bytes(x) + 1, 0)
                : 0),
          0,
        )
      if (remaining < 0) {
        omitted = truncated = true
        return
      }
      items.push(item)
    }
    if (w && typeof w === 'object') {
      for (const part of ['body', 'params']) if (w[part] != null) walk(w[part], part, part, 0)
    } else walk(w, '', '', 0)
    widgets.push({ key: cut(key, 100), module: cut(w?.module_id, 100), items, truncated: omitted })
  }
  while (bytes(shape) > 16384 && widgets.length) {
    widgets.pop()
    truncated = true
  }
  let html = '<article class="sketch">'
  const add = (v: string) => {
    if (bytes(html + v + '</article>') > 6144) {
      truncated = true
      return false
    }
    html += v
    return true
  }
  const line = (tag: string, value: string) => {
    let v = value
    while (v && !add('<' + tag + '>' + esc(v) + '</' + tag.split(' ')[0] + '>'))
      v = Array.from(v)
        .slice(0, Math.floor(Array.from(v).length / 2))
        .join('')
  }
  line('h1', fields.subject ?? '')
  line('p class="from"', [fields.from_name, fields.from_email].filter(Boolean).join(' '))
  line('p class="plain"', content.plain_text ?? '')
  for (const w of widgets) {
    let section = '<section class="widget" data-widget="' + esc(w.key) + '">'
    for (const i of w.items) {
      if (i.kind === 'text') section += '<p>' + esc(i.text) + '</p>'
      if (i.kind === 'link') section += '<span class="button">' + esc(i.href) + '</span>'
      if (i.kind === 'image') section += '<span class="image">' + esc(i.src) + '</span>'
    }
    if (!add(section + '</section>')) break
  }
  shape.limits.truncated = truncated
  return {
    ...shape,
    render: {
      html: html + '</article>',
      completeness: 'partial',
      reason: truncated ? 'cut' : 'provider_renders_template',
    },
  }
}
