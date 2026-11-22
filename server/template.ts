import { z } from 'zod'
import { visit } from 'jsonc-parser'
import { digest } from './store.ts'
import { bundleHash, templateOps } from './template-preview.ts'
const path = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (s) =>
      s.split('/').every((segment) => /^[A-Za-z0-9_@][A-Za-z0-9_.@-]{0,79}$/.test(segment)) &&
      /\.(html|css|json|js|md|txt)$/i.test(s),
  )
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const file = z
  .object({
    path,
    content: z
      .string()
      .refine(
        (s) =>
          Buffer.byteLength(s) <= 262144 &&
          !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF]/u.test(s),
      ),
  })
  .strict()
const defaults: Record<string, unknown> = {
  locked: false,
  display_width: null,
  allow_new_line: false,
  required: false,
  expanded: false,
  group_occurrence_meta: null,
  sorting_label_field: null,
  tab: 'CONTENT',
  multiple: false,
  preset: null,
  reordering_enabled: true,
  show_loading: false,
  host_template_types: ['ANY'],
}
function canonicalText(path: string, content: string) {
  if (!path.toLowerCase().endsWith('.json')) return content
  const seen: Set<string>[] = []
  let valid = true,
    nodes = 0
  visit(
    content,
    {
      onObjectBegin: () => {
        seen.push(new Set())
      },
      onObjectEnd: () => {
        seen.pop()
      },
      onObjectProperty: (k) => {
        if (seen.at(-1)?.has(k)) valid = false
        seen.at(-1)?.add(k)
      },
      onError: () => {
        valid = false
      },
    },
    { disallowComments: true },
  )
  const value = JSON.parse(content)
  if (
    !valid ||
    !value ||
    typeof value !== 'object' ||
    content.includes('{{') ||
    content.includes('{%')
  )
    throw Error('Invalid template JSON')
  function clean(v: any, names: string[], depth: number): any {
    if (++nodes > 20000 || depth > 32) throw Error('Template JSON exceeds limits')
    if (Array.isArray(v)) return v.map((x) => clean(x, names, depth + 1))
    if (!v || typeof v !== 'object') return v
    const here = typeof v.name === 'string' ? [...names, v.name] : names
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .filter(
          (k) =>
            !(
              (Object.hasOwn(defaults, k) &&
                JSON.stringify(v[k]) === JSON.stringify(defaults[k])) ||
              (k === 'module_id' && Number.isSafeInteger(v[k]) && v[k] > 0) ||
              (k === 'id' && typeof v.name === 'string' && v[k] === here.join('.'))
            ),
        )
        .map((k) => [k, clean(v[k], k === 'children' ? here : names, depth + 1)]),
    )
  }
  return JSON.stringify(clean(value, [], 0))
}
export function templatePlan(op: string, args: unknown, roots: string[]) {
  if (Buffer.byteLength(JSON.stringify(args)) > 56000) throw Error('Bundle exceeds limit')
  const upload = op === templateOps[0]
  const plan = upload
    ? z
        .object({ files: z.array(file).min(1).max(40), bundle_sha256: hash })
        .strict()
        .parse(args)
    : z
        .object({ paths: z.array(path).min(1).max(40), bundle_sha256: hash })
        .strict()
        .parse(args)
  const files = 'files' in plan ? plan.files : plan.paths.map((path) => ({ path, content: '' }))
  const paths = files.map((f) => f.path)
  if (
    new Set(paths).size !== paths.length ||
    paths.some((p) => !roots.some((r) => r.endsWith('/') && r.length > 1 && p.startsWith(r)))
  )
    throw Error('Template outside approved directory')
  if (upload) {
    for (const f of files) canonicalText(f.path, f.content)
    if (bundleHash(files.map((f) => [f.path, digest(f.content)])) !== plan.bundle_sha256)
      throw Error('Template digest mismatch')
  }
  return {
    upload,
    files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
    hash: plan.bundle_sha256,
  }
}
export async function writeTemplate(
  plan: ReturnType<typeof templatePlan>,
  token: string,
  send: typeof fetch,
  check: () => void,
) {
  const base = 'https://api.hubapi.com/cms/v3/source-code/'
  const headers = { Authorization: 'Bearer ' + token }
  if (!plan.upload) {
    for (const f of plan.files) {
      check()
      const r = await send(base + 'draft/content/' + f.path, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      })
      if (!r.ok || !r.body) {
        await r.body?.cancel()
        throw Error('Draft unavailable')
      }
      const reader = r.body.getReader(),
        chunks: Buffer[] = []
      let length = 0
      for (;;) {
        const v = await reader.read()
        if (v.done) break
        length += v.value.length
        if (length > 262144) {
          await reader.cancel()
          throw Error('Draft too large')
        }
        chunks.push(Buffer.from(v.value))
      }
      f.content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      file.parse(f)
    }
    if (
      bundleHash(plan.files.map((f) => [f.path, digest(canonicalText(f.path, f.content))])) !==
      plan.hash
    )
      throw Error('Stored draft digest mismatch')
  }
  const environment = plan.upload ? 'draft' : 'published'
  for (const f of plan.files) {
    check()
    const body = new FormData()
    body.set(
      'file',
      new Blob([f.content], { type: 'application/octet-stream' }),
      f.path.split('/').at(-1)!,
    )
    const r = await send(base + environment + '/content/' + f.path, {
      method: 'PUT',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    })
    await r.body?.cancel()
    if (!r.ok) throw Error('Template write incomplete')
  }
  return {
    provider: 'hubspot',
    operation: plan.upload ? 'upload_template_source' : 'publish_template_source',
    environment,
    delivery_state: environment,
    publication_authorization: plan.upload ? 'not_authorized' : 'authorized',
    remote_id: plan.hash,
    bundle_sha256: plan.hash,
    file_count: plan.files.length,
    files: plan.files.map((f) => ({
      path: f.path,
      bytes: Buffer.byteLength(f.content),
      sha256: digest(f.content),
    })),
  }
}
