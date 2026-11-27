import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { EngineCli } from '../server/engine-cli.ts'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Records its process id, ignores the polite stop, then holds stdout open without ever replying.
async function silentEngine(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'op-engine-hang-')),
    epoch = mkdtempSync(join(dir, 'epoch-')),
    binary = join(dir, 'silent-engine'),
    database = join(dir, 'flows.sqlite')
  writeFileSync(binary, '#!/bin/sh\ntrap "" TERM\necho $$ > "$1.pid"\nexec sleep 60\n')
  chmodSync(binary, 0o700)
  const cli = new EngineCli(binary, database, epoch, 500)
  let pid = 0
  t.after(() => {
    cli.close()
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  })
  for (let i = 0; i < 100 && !existsSync(database + '.pid'); i++) await sleep(20)
  pid = Number(readFileSync(database + '.pid', 'utf8'))
  assert.ok(pid > 0 && alive(pid))
  const gone = async () => {
    for (let i = 0; i < 250 && alive(pid); i++) await sleep(20)
    return !alive(pid)
  }
  return { cli, gone }
}

test(
  'a workflow engine that never answers fails the call and is killed behind its guardian',
  { timeout: 15000 },
  async (t) => {
    const { cli, gone } = await silentEngine(t)
    await assert.rejects(cli.call({ op: 'poll' }), /timed out/)
    assert.ok(await gone(), 'the stuck engine survived the timeout')
    await assert.rejects(cli.call({ op: 'poll' }), /unavailable/)
  },
)

test('closing ends an idle engine that ignores the request', { timeout: 15000 }, async (t) => {
  const { cli, gone } = await silentEngine(t)
  cli.close()
  assert.ok(await gone(), 'the engine survived close')
})
