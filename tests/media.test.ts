import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeMedia, convertMedia } from '../packages/connectors/local.ts'
test(
  'FFmpeg renders and probes a media file with no overwrite',
  { skip: spawnSync('ffmpeg', ['-version']).status !== 0 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'op-media-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, 'source.wav'),
      out = join(dir, 'output.mp3')
    assert.equal(
      spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.1', file])
        .status,
      0,
    )
    await convertMedia(file, out, 'audio')
    assert.equal((await probeMedia(out)).streams[0].codec_name, 'mp3')
    await assert.rejects(convertMedia(file, out, 'audio'))
  },
)
