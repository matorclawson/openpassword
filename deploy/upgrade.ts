// Invoked by upgrade.sh under its exclusive flock, after verification of the staged archive.
import * as fs from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const root = '/opt/openpassword'
const releases = join(root, 'releases')
const state = join(root, 'upgrade-state')
const units = ['openpassword-broker.service', 'openpassword-web.service']
const unitDir = '/etc/systemd/system'
const dataLink = '/var/lib/openpassword'
const semver = /^\d+\.\d+\.\d+$/
type Snapshot = { version: string | null; units: (string | null)[] }
// Pending record: the old configuration plus the vault copy taken before the candidate first started.
type Pending = Snapshot & { store?: string | null }
function ensure(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message)
}
function run(cmd: string, args: string[], timeout = 180000) {
  const p = spawnSync(cmd, args, { encoding: 'utf8', timeout })
  ensure(!p.error && p.status === 0, cmd + ' failed: ' + (p.error?.message || p.stderr.trim()))
  return p.stdout.trim()
}
function syncDir(dir: string) {
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
function atomic(file: string, content: string, mode = 0o600) {
  const temp = file + '.' + randomUUID()
  const fd = fs.openSync(temp, 'wx', mode)
  try {
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, file)
  syncDir(dirname(file))
}
function clear(file: string) {
  fs.rmSync(file, { force: true })
  syncDir(dirname(file))
}
function releasePath(v: string) {
  ensure(semver.test(v), 'Invalid release version')
  return join(releases, v)
}
function active() {
  const link = join(root, 'current')
  if (!fs.lstatSync(link, { throwIfNoEntry: false })) return null
  const real = fs.realpathSync(link),
    v = basename(real)
  ensure(
    fs.lstatSync(link).isSymbolicLink() && real === releasePath(v),
    'Unexpected current layout',
  )
  return v
}
function snapshot(): Snapshot {
  return {
    version: active(),
    units: units.map((u) =>
      fs.existsSync(join(unitDir, u)) ? fs.readFileSync(join(unitDir, u), 'utf8') : null,
    ),
  }
}
const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex')
// A failed activation must not leave an older release on a store that the candidate migrated.
// Copy every file of the stopped state directory (vault, sidecars, keys) with owner and mode,
// check the bytes, then run SQLite's integrity check on a scratch copy.
export function snapshotStore(dataDir: string, dest: string) {
  const names = fs.readdirSync(dataDir)
  ensure(names.includes('vault.sqlite'), 'Vault database missing from the state directory')
  fs.mkdirSync(dest, { mode: 0o700 })
  for (const name of names) {
    const src = join(dataDir, name),
      st = fs.lstatSync(src)
    ensure(st.isFile() && !st.isSymbolicLink(), 'Unexpected entry in the state directory: ' + name)
    const out = join(dest, name)
    fs.copyFileSync(src, out, fs.constants.COPYFILE_EXCL)
    fs.chownSync(out, st.uid, st.gid)
    fs.chmodSync(out, st.mode & 0o7777)
    fs.utimesSync(out, st.atime, st.mtime)
    ensure(sha(out) === sha(src), 'Snapshot copy differs from the source: ' + name)
    const fd = fs.openSync(out, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }
  const scratch = fs.mkdtempSync(join(tmpdir(), 'op-snap-'))
  try {
    for (const name of names) fs.copyFileSync(join(dest, name), join(scratch, name))
    const db = new DatabaseSync(join(scratch, 'vault.sqlite'))
    try {
      const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
      ensure(rows.length === 1 && rows[0].integrity_check === 'ok', 'Vault snapshot failed its integrity check')
    } finally {
      db.close()
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  syncDir(dest)
}
// Services must be stopped. Replaces the contents of the state directory with the snapshot.
export function restoreStore(dataDir: string, snap: string) {
  const names = fs.readdirSync(snap)
  ensure(names.includes('vault.sqlite'), 'Vault snapshot is incomplete')
  for (const name of fs.readdirSync(dataDir)) fs.rmSync(join(dataDir, name), { recursive: true, force: true })
  for (const name of names) {
    const src = join(snap, name),
      st = fs.lstatSync(src),
      out = join(dataDir, name)
    fs.copyFileSync(src, out, fs.constants.COPYFILE_EXCL)
    fs.chownSync(out, st.uid, st.gid)
    fs.chmodSync(out, st.mode & 0o7777)
    ensure(sha(out) === sha(src), 'Restored file differs from the snapshot: ' + name)
  }
  syncDir(dataDir)
}
function dataDir() {
  return fs.existsSync(dataLink) ? fs.realpathSync(dataLink) : null
}
function point(version: string | null) {
  const link = join(root, 'current')
  if (!version) {
    clear(link)
    return
  }
  const tmp = link + '.' + randomUUID()
  fs.symlinkSync(releasePath(version), tmp)
  fs.renameSync(tmp, link)
  syncDir(root)
}
export function verifyRelease(
  tree: string,
  digest: string,
  v: string,
  commit: string,
  arch: string,
) {
  const meta = JSON.parse(fs.readFileSync(join(tree, 'RELEASE.json'), 'utf8'))
  ensure(
    meta.name === 'openpassword' &&
      meta.platform === 'linux' &&
      meta.version === v &&
      meta.commit === commit &&
      process.platform === 'linux' &&
      meta.arch === arch &&
      arch === process.arch,
    'Release identity mismatch',
  )
  ensure(meta.node === 'v24.19.0' && process.version === meta.node, 'Unexpected Node version')
  for (const file of [
    'server/main.ts',
    '.next/BUILD_ID',
    'packages/cli/dist/index.js',
    'node_modules/tsx/package.json',
    'node_modules/next/dist/bin/next',
    '.next/server/server-reference-manifest.json',
    '.next/server/server-reference-manifest.js',
    ...units.map((u) => 'deploy/systemd/' + u),
  ])
    ensure(fs.statSync(join(tree, file)).isFile(), 'Missing ' + file)
  ensure(
    fs.readFileSync(join(tree, '.next/BUILD_ID'), 'utf8').trim() === commit,
    'Console build ID mismatch',
  )
  ensure(
    createHash('sha256')
      .update(fs.readFileSync(join(tree, 'node/bin/node')))
      .digest('hex') === meta.node_binary_sha256,
    'Node digest mismatch',
  )
  ensure(/^[a-f0-9]{64}$/.test(digest), 'Invalid archive digest')
}
const probeCode = `
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { service } from './server/service.ts';
const home=mkdtempSync(join(tmpdir(),'op-check-'));
try {
 const api=service(home);
 try {const url=await api.listen({host:'127.0.0.1',port:0});
 if((await (await fetch(url+'/health')).json()).status!=='ok') throw Error('Broker unavailable');
 } finally {await api.close()}
} finally {rmSync(home,{recursive:true,force:true})}`
function preflight(version: string) {
  const path = releasePath(version)
  const node = fs.existsSync(join(path, 'node/bin/node'))
    ? [join(path, 'node/bin/node')]
    : ['/usr/bin/env', 'node']
  const base = [
    '--quiet',
    '--wait',
    '--pipe',
    '-p',
    'DynamicUser=yes',
    '-p',
    'PrivateTmp=yes',
    '-p',
    'ProtectHome=yes',
    '-p',
    'NoNewPrivileges=yes',
    '-p',
    'ProtectSystem=strict',
    '-p',
    'InaccessiblePaths=-/var/lib/openpassword -/var/lib/private',
    '-p',
    'WorkingDirectory=' + path,
    ...node,
  ]
  const runtime = run('systemd-run', [...base, '-p', 'process.version'])
  if (node.length === 1) ensure(runtime === 'v24.19.0', 'Bundled service Node mismatch')
  run('systemd-run', [...base, '--import', 'tsx', '--input-type=module', '-e', probeCode])
  run('systemd-run', [...base, 'node_modules/next/dist/bin/next', '--version'])
}
function baseUrl() {
  const port = Number(process.env.OPENPASSWORD_WEB_PORT || 3000)
  ensure(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid console port')
  return 'http://127.0.0.1:' + port
}
async function health() {
  const res = await fetch(baseUrl() + '/api/health', {
    signal: AbortSignal.timeout(2500),
    redirect: 'error',
  })
  ensure(res.ok, 'Health HTTP ' + res.status)
  return await res.json()
}
async function drain() {
  const h = await health()
  if (!h.drain_supported) return
  run('systemctl', ['kill', '--kill-who=main', '--signal=SIGUSR2', units[0]])
  const end = Date.now() + 90000
  while (Date.now() < end) {
    const s = await health()
    if (s.status === 'draining' && s.in_flight === 0) return
    await sleep(200)
  }
  console.error('Drain deadline reached. Continuing with service shutdown.')
}
async function ready(v: string) {
  const end = Date.now() + 40000
  let last: unknown
  do {
    try {
      ensure((await health()).status === 'ok', 'Broker is unavailable')
      const r = await fetch(baseUrl() + '/', {
        signal: AbortSignal.timeout(2500),
        redirect: 'error',
      })
      ensure(r.ok && (await r.text()).includes('OpenPassword'), 'Console unavailable')
      for (const u of units) {
        const pid = run('systemctl', ['show', '-p', 'MainPID', '--value', u])
        ensure(
          /^[1-9]\d*$/.test(pid) && fs.realpathSync('/proc/' + pid + '/cwd') === releasePath(v),
          'Service release mismatch: ' + u,
        )
        const node = join(releasePath(v), 'node/bin/node')
        if (fs.existsSync(node))
          ensure(fs.realpathSync('/proc/' + pid + '/exe') === node, 'Service Node mismatch: ' + u)
      }
      return
    } catch (e) {
      last = e
      await sleep(300)
    }
  } while (Date.now() < end)
  throw Error('Readiness failed: ' + String(last))
}
function stop() {
  for (const unit of [...units].reverse()) {
    const loaded = run('systemctl', ['show', '-p', 'LoadState', '--value', unit])
    if (loaded !== 'not-found') run('systemctl', ['stop', unit])
  }
}
async function switchTo(target: Snapshot, restoreFrom?: string | null) {
  stop()
  if (restoreFrom) {
    const dir = dataDir()
    ensure(dir, 'State directory missing for the vault restore')
    restoreStore(dir, restoreFrom)
  }
  point(target.version)
  units.forEach((unit, i) => {
    const content = target.units[i],
      path = join(unitDir, unit)
    if (content === null) clear(path)
    else atomic(path, content, 0o644)
  })
  run('systemctl', ['daemon-reload'])
  if (target.version) {
    run('systemctl', ['start', ...units])
    await ready(target.version)
  }
}
export async function activate(
  old: Snapshot,
  target: Snapshot,
  ops: {
    save: (s: Pending) => void
    drain: () => Promise<void>
    stop: () => void
    backup: () => string | null
    switchTo: (s: Snapshot, restoreFrom?: string | null) => Promise<void>
    finish: (s: Snapshot, store: string | null) => void
    clear: () => void
    discard: (store: string | null) => void
  },
) {
  ops.save(old)
  let store: string | null = null
  try {
    if (old.version) await ops.drain()
    ops.stop()
    store = old.version ? ops.backup() : null
    if (store) ops.save({ ...old, store })
    await ops.switchTo(target)
    ops.finish(old, store)
  } catch (error) {
    await ops.switchTo(old, store)
    ops.discard(store)
    ops.clear()
    throw error
  }
  ops.clear()
}
async function main() {
  ensure(process.getuid?.() === 0, 'Requires root and the upgrade.sh lock')
  const pending = join(state, 'pending.json'),
    previous = join(state, 'previous.json')
  const [action, tree, digest, version, commit, arch] = process.argv.slice(2)
  if (fs.existsSync(pending)) {
    const p: Pending = JSON.parse(fs.readFileSync(pending, 'utf8'))
    await switchTo(p, p.store)
    clear(pending)
    console.log('Recovered previous service configuration.')
  }
  if (action === '--recover') return
  const old = snapshot()
  let target: Snapshot
  if (action === '--rollback') {
    target = JSON.parse(fs.readFileSync(previous, 'utf8'))
    ensure(target.version, 'First installation has no previous release')
  } else {
    ensure(action === '--install', 'Unknown operation')
    verifyRelease(tree, digest, version, commit, arch)
    const dest = releasePath(version),
      receipt = '.openpassword-archive-sha256'
    if (fs.existsSync(dest)) {
      ensure(
        fs.readFileSync(join(dest, receipt), 'utf8') === digest,
        'Version already installed with different provenance',
      )
    } else {
      atomic(join(tree, receipt), digest)
      fs.chmodSync(tree, 0o755)
      fs.renameSync(tree, dest)
      syncDir(releases)
    }
    target = {
      version,
      units: units.map((u) => fs.readFileSync(join(dest, 'deploy/systemd', u), 'utf8')),
    }
  }
  if (old.version === target.version && old.version) {
    await ready(old.version)
    console.log('Already active: ' + old.version)
    return
  }
  preflight(target.version!)
  const keep = (n: string) => n.startsWith('store-')
  for (const n of fs.readdirSync(state).filter(keep)) {
    const prev = fs.existsSync(previous) ? (JSON.parse(fs.readFileSync(previous, 'utf8')) as Pending).store : null
    if (join(state, n) !== prev) fs.rmSync(join(state, n), { recursive: true, force: true })
  }
  await activate(old, target, {
    save: (s) => atomic(pending, JSON.stringify(s)),
    stop,
    backup: () => {
      const dir = dataDir()
      if (!dir) return null
      const made = join(state, 'store-' + randomUUID())
      snapshotStore(dir, made)
      return made
    },
    drain: async () => {
      if (action !== '--rollback') return drain()
      try {
        await drain()
      } catch {
        console.error('Rolling back unavailable broker')
      }
    },
    switchTo,
    // previous.json names the vault copy for the operator. --rollback never restores it: the new release has written since.
    finish: (s, store) => atomic(previous, JSON.stringify({ ...s, store })),
    clear: () => clear(pending),
    discard: (store) => {
      if (store) fs.rmSync(store, { recursive: true, force: true })
    },
  })
  console.log('Ready: ' + target.version)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
