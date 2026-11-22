type Request = Record<string, unknown>
function docsAnchor(request: Request) {
  for (const item of Object.values(request)) {
    if (item && typeof item === 'object') {
      const p = item as {
        location?: { index?: number }
        range?: { startIndex?: number }
        endOfSegmentLocation?: object
      }
      if (Number.isInteger(p.location?.index)) return p.location!.index!
      if (Number.isInteger(p.range?.startIndex)) return p.range!.startIndex!
      if (p.endOfSegmentLocation) return -1
    }
  }
  return -1
}
export function googleBatch(product: 'docs' | 'slides' | 'sheets', requests: readonly Request[]) {
  if (
    !Array.isArray(requests) ||
    requests.some((r) => !r || Array.isArray(r) || typeof r !== 'object')
  )
    throw Error('Expected Google batch requests')
  const out = structuredClone([...requests])
  return product === 'docs' ? out.sort((a, b) => docsAnchor(b) - docsAnchor(a)) : out
}
export function slideObjectId(prefix = 'obj') {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_:-]{0,16}$/.test(prefix))
    throw Error('Invalid Slides object prefix')
  return prefix + '_' + crypto.randomUUID().replaceAll('-', '')
}
