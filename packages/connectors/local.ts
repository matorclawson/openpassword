// Local file conversion belongs in the caller process, outside the credential broker.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { access, link, mkdtemp, rm } from 'node:fs/promises'
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
