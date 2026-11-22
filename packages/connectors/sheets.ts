import { z } from 'zod'
const range = z
  .string()
  .regex(
    /^(?:'[^'!\r\n]{1,100}'|[A-Za-z0-9_]{1,100})![A-Z]{1,3}[0-9]{0,7}(?::[A-Z]{1,3}[0-9]{0,7})?$/,
  )
const id = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/)
const rows = z
  .array(
    z
      .array(z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
      .min(1)
      .max(20),
  )
  .min(1)
  .max(50)
export function sheetsRequest(op: string, args: Record<string, unknown>, secret: string) {
  const spreadsheet = id.parse(args.spreadsheet_id)
  const root = 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheet + '/values'
  const headers: Record<string, string> = {
    Authorization: 'Bearer ' + secret,
    'Content-Type': 'application/json',
  }
  let url: URL,
    method = 'GET',
    body: string | undefined
  if (op === 'sheets.read_range' || op === 'sheets.batch_get') {
    const batch = op === 'sheets.batch_get',
      ranges = batch ? z.array(range).min(1).max(10).parse(args.ranges) : [range.parse(args.range)]
    if (Object.keys(args).some((k) => !['spreadsheet_id', batch ? 'ranges' : 'range'].includes(k)))
      throw Error('Invalid fields')
    url = new URL(root + ':batchGet')
    for (const r of ranges) url.searchParams.append('ranges', r)
  } else {
    const append = op === 'sheets.append_rows',
      field = append ? 'rows' : 'values'
    if (Object.keys(args).some((k) => !['spreadsheet_id', 'range', field].includes(k)))
      throw Error('Invalid fields')
    const values = rows.parse(args[field])
    if (Buffer.byteLength(JSON.stringify(values)) > 16384) throw Error('Rows too large')
    url = new URL(
      root + '/' + encodeURIComponent(range.parse(args.range)) + (append ? ':append' : ''),
    )
    url.searchParams.set('valueInputOption', 'RAW')
    if (append) url.searchParams.set('insertDataOption', 'INSERT_ROWS')
    method = append ? 'POST' : 'PUT'
    body = JSON.stringify({ values })
  }
  return {
    url,
    init: { method, headers, body, redirect: 'error' as const, signal: AbortSignal.timeout(12000) },
  }
}
export function sheetsResult(op: string, v: unknown) {
  if (!['sheets.read_range', 'sheets.batch_get'].includes(op)) return v
  const found = z
    .object({
      valueRanges: z
        .array(z.object({ range: z.string(), values: z.array(z.array(z.unknown())).default([]) }))
        .min(1)
        .max(10),
    })
    .parse(v)
  if (
    Buffer.byteLength(JSON.stringify(found)) > 262144 ||
    found.valueRanges.reduce((n, r) => n + r.values.reduce((m, row) => m + row.length, 0), 0) > 5000
  )
    throw Error('Result too large')
  return op === 'sheets.read_range' ? found.valueRanges[0] : { ranges: found.valueRanges }
}
