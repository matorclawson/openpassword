import { digest } from './store.ts'
export const templateOps = [
  'hubspot.newsletter.upload_template_source',
  'hubspot.newsletter.publish_template_source',
]
type Entry = { path: string; bytes: number | null; sha256: string | null }
export function bundleHash(pairs: readonly (readonly string[])[]) {
  return digest(JSON.stringify([...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))))
}
export function templatePreview(op: string, args: Record<string, any>, device: object) {
  const upload = op === templateOps[0],
    raw = upload ? args.files : args.paths
  if (!Array.isArray(raw) || !raw.length || raw.length > 40) return null
  const files: Entry[] = []
  for (const item of raw) {
    const path = upload ? item?.path : item
    if (
      typeof path !== 'string' ||
      Array.from(path).length > 300 ||
      files.some((f) => f.path === path)
    )
      return null
    if (upload && (typeof item.content !== 'string' || /[\uD800-\uDFFF]/u.test(item.content)))
      return null
    files.push({
      path,
      bytes: upload ? Buffer.byteLength(item.content) : null,
      sha256: upload ? digest(item.content) : null,
    })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const hash = upload
    ? bundleHash(files.map((f) => [f.path, f.sha256!]))
    : String(args.bundle_sha256 ?? '').slice(0, 64)
  const matches = upload ? hash === args.bundle_sha256 : null
  const statement =
    'The approval binds the bundle hash. The code was reviewed before this request; compare the bundle hash with the one you were given.'
  const esc = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c]!,
    )
  let html =
    '<article class="sketch"><h1>Template files to the ' +
    (upload ? 'draft' : 'published') +
    ' environment</h1><p class="plain">' +
    statement +
    '</p>'
  if (hash)
    html +=
      '<p class="plain">' +
      (upload
        ? 'Bundle hash (computed by the Broker)'
        : 'Bundle hash as DECLARED by the request (not computed here)') +
      ': ' +
      esc(hash) +
      '</p>'
  if (matches === false)
    html += '<p class="plain">The hash the request declared does NOT match.</p>'
  const shown: Entry[] = []
  let truncated = false,
    budget = 14336,
    renderCut = false
  for (const f of files) {
    budget -= 200 + Buffer.byteLength(JSON.stringify(f.path))
    if (budget < 0) {
      truncated = true
      break
    }
    shown.push(f)
    const line =
      '<p>' + esc(f.path) + (upload ? ' (' + f.bytes + ' bytes) ' + f.sha256 : '') + '</p>'
    if (Buffer.byteLength(JSON.stringify(html + line + '</article>')) > 6146) {
      truncated = renderCut = true
    }
    if (!renderCut) html += line
  }
  return {
    schema: 'approval-snapshot/1',
    kind: 'template_bundle',
    provider: 'hubspot',
    operation: op,
    environment: upload ? 'draft' : 'publish',
    files: shown,
    file_count: files.length,
    total_bytes: upload ? files.reduce((n, f) => n + f.bytes!, 0) : null,
    bundle_sha256: hash,
    declared_bundle_matches: matches,
    new_or_replace: 'unknown',
    statement,
    requested_by: device,
    limits: { truncated },
    render: {
      html: html + '</article>',
      completeness: 'partial',
      reason: truncated ? 'cut' : 'provider_renders_template',
    },
  }
}
