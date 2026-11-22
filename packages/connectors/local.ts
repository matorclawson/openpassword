import { createHash } from 'node:crypto'
// Local file conversion belongs in the caller process, outside the credential broker.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { access, link, mkdtemp, rm, readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
export type Cell = {
  cell_type: 'code' | 'markdown'
  metadata: Record<string, unknown>
  source: string[]
  outputs?: unknown[]
  execution_count?: number | null
}
export type Notebook = {
  nbformat: 4
  nbformat_minor: 4
  metadata: Record<string, unknown>
  cells: Cell[]
}
export function scriptToNotebook(script: string): Notebook {
  const cells: Cell[] = []
  let kind: Cell['cell_type'] = 'code',
    lines: string[] = [],
    marked = false
  const flush = () => {
    if (lines.length || marked)
      cells.push({
        cell_type: kind,
        metadata: {},
        source: lines,
        ...(kind === 'code' ? { outputs: [], execution_count: null } : {}),
      })
    lines = []
  }
  for (const line of script.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const marker = /^#\s*%%(?:\s*\[(markdown)\])?\s*$/.exec(line)
    if (marker) {
      flush()
      kind = marker[1] ? 'markdown' : 'code'
      marked = true
    } else lines.push(kind === 'markdown' ? line.replace(/^# ?/, '') : line)
  }
  flush()
  return { nbformat: 4, nbformat_minor: 4, metadata: {}, cells }
}
export function notebookToScript(n: Notebook) {
  if (n.nbformat !== 4) throw Error('Expected notebook format 4')
  return n.cells
    .map((c) => {
      if (!['code', 'markdown'].includes(c.cell_type)) throw Error('Unsupported cell type')
      const text = Array.isArray(c.source) ? c.source.join('') : String(c.source)
      const body = c.cell_type === 'markdown' ? text.replace(/^(?=.)/gm, '# ') : text
      return (
        (c.cell_type === 'markdown' ? '# %% [markdown]\n' : '# %%\n') +
        body +
        (body && !body.endsWith('\n') ? '\n' : '')
      )
    })
    .join('')
}
function execute(binary: string, args: string[], timeout = 120000): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
      killSignal: 'SIGKILL',
    })
    let length = 0
    const out: Buffer[] = []
    child.stdout.on('data', (b: Buffer) => {
      length += b.length
      if (length > 4194304) child.kill('SIGKILL')
      else out.push(b)
    })
    child.once('error', fail)
    child.once('close', (code) =>
      code === 0 ? ok(Buffer.concat(out).toString()) : fail(Error(binary + ' failed')),
    )
  })
}
export async function probeMedia(input: string) {
  await access(input)
  return JSON.parse(
    await execute('ffprobe', [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      resolve(input),
    ]),
  )
}
export async function convertMedia(
  input: string,
  output: string,
  kind: 'h264' | 'audio' | 'thumbnail',
) {
  const profiles = {
    h264: ['-c:v', 'libx264', '-c:a', 'aac', '-f', 'mp4'],
    audio: ['-vn', '-c:a', 'libmp3lame', '-f', 'mp3'],
    thumbnail: ['-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2'],
  }
  const tmp = await mkdtemp(join(dirname(resolve(output)), '.openpassword-media-')),
    rendered = join(tmp, 'output')
  try {
    await execute('ffmpeg', [
      '-nostdin',
      '-loglevel',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      resolve(input),
      ...profiles[kind],
      rendered,
    ])
    await link(rendered, resolve(output))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

type CellFact = {
  ordinal: number
  cell_type: string
  cell_id: string | null
  tags: string[]
  source_sha256: string
  metadata_sha256: string
  attachments_sha256: string
}
const semanticSchema = 'zeocore.notebook-semantics.v1'
function stable(v: unknown) {
  return JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  )
}
function sha(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
export function notebookSemantics(input: string, format: 'percent' | 'ipynb') {
  if (!input.trim()) throw Error('EMPTY_INPUT')
  const doc = format === 'ipynb' ? JSON.parse(input) : scriptToNotebook(input)
  if (!Array.isArray(doc?.cells)) throw Error('INVALID_NOTEBOOK')
  if (!doc.cells.length) throw Error('ZERO_CELLS')
  const metadata = structuredClone(doc.metadata ?? {})
  if (metadata.jupytext?.text_representation)
    delete metadata.jupytext.text_representation.jupytext_version
  const cells: CellFact[] = doc.cells.map((c: Record<string, any>, ordinal: number) => {
    if (!['code', 'markdown', 'raw'].includes(c.cell_type)) throw Error('UNSUPPORTED_CELL_TYPE')
    const lines = c.source ?? '',
      source =
        Array.isArray(lines) && lines.every((s) => typeof s === 'string') ? lines.join('') : lines
    if (typeof source !== 'string') throw Error('INVALID_NOTEBOOK')
    return {
      ordinal,
      cell_type: c.cell_type,
      cell_id: format === 'ipynb' ? (c.id ?? null) : null,
      tags: c.metadata?.tags ?? [],
      source_sha256: sha(source.replace(/\r\n/g, '\n')),
      metadata_sha256: sha(stable(c.metadata ?? {})),
      attachments_sha256: sha(stable(c.attachments ?? {})),
    }
  })
  return { metadata, cells }
}
export function compareNotebookSemantics(
  left: ReturnType<typeof notebookSemantics>,
  right: ReturnType<typeof notebookSemantics>,
) {
  let mismatch: string | null = null
  if (stable(left.metadata) !== stable(right.metadata)) mismatch = 'NOTEBOOK_METADATA'
  else if (left.cells.length !== right.cells.length) mismatch = 'CELL_COUNT'
  else
    outer: for (let i = 0; i < left.cells.length; i++)
      for (const k of Object.keys(left.cells[i]) as (keyof CellFact)[])
        if (stable(left.cells[i][k]) !== stable(right.cells[i][k])) {
          mismatch = 'CELL_' + i + ':' + k
          break outer
        }
  return {
    semantic_schema: semanticSchema,
    equivalent: !mismatch,
    source_digest: sha(stable({ schema: semanticSchema, content: left })),
    derived_digest: sha(stable({ schema: semanticSchema, content: right })),
    mismatch,
  }
}
export async function convertNotebookFile(source: string, output: string) {
  const from = source.endsWith('.ipynb') ? 'ipynb' : 'percent',
    to = from === 'ipynb' ? 'percent' : 'ipynb'
  if (
    !source.endsWith(from === 'ipynb' ? '.ipynb' : '.py') ||
    !output.endsWith(to === 'ipynb' ? '.ipynb' : '.py')
  )
    throw Error('Unsupported conversion')
  const input = await readFile(source, 'utf8')
  const rendered =
    from === 'ipynb'
      ? notebookToScript(JSON.parse(input))
      : JSON.stringify(scriptToNotebook(input), null, 2) + '\n'
  const receipt = compareNotebookSemantics(
    notebookSemantics(input, from),
    notebookSemantics(rendered, to),
  )
  if (!receipt.equivalent) throw Error(receipt.mismatch!)
  const scratch = await mkdtemp(join(dirname(resolve(output)), '.openpassword-convert-'))
  try {
    const tmp = join(scratch, 'output')
    await writeFile(tmp, rendered, { mode: 0o600 })
    await link(tmp, output)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return {
    ...receipt,
    input_bytes: Buffer.byteLength(input),
    output_bytes: Buffer.byteLength(rendered),
    input_sha256: sha(input),
    output_sha256: sha(rendered),
  }
}
export async function convertNotebookDirectory(
  directory: string,
  output: string,
  from: 'ipynb' | 'percent',
) {
  const ext = from === 'ipynb' ? '.ipynb' : '.py',
    files = (await readdir(directory, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(ext))
      .map((e) => e.name)
      .sort()
  await mkdir(output, { recursive: true })
  const results = []
  for (const file of files) {
    const dest = join(output, file.slice(0, -ext.length) + (from === 'ipynb' ? '.py' : '.ipynb'))
    try {
      results.push({
        file,
        output: dest,
        receipt: await convertNotebookFile(join(directory, file), dest),
      })
    } catch (e) {
      results.push({
        file,
        output: dest,
        error:
          (e as NodeJS.ErrnoException).code ??
          (e instanceof Error &&
          /^(CELL_|NOTEBOOK_METADATA|ZERO_CELLS|INVALID_NOTEBOOK|EMPTY_INPUT)/.test(e.message)
            ? e.message
            : 'CONVERSION_FAILED'),
      })
    }
  }
  return results
}
