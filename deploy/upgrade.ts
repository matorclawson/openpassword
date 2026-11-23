// Invoked by upgrade.sh under its exclusive flock, after verification of the staged archive.
import * as fs from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const root = '/opt/openpassword'
const releases = join(root, 'releases')
const state = join(root, 'upgrade-state')
const units = ['openpassword-broker.service', 'openpassword-web.service']
const unitDir = '/etc/systemd/system'
const semver = /^\d+\.\d+\.\d+$/
type Snapshot = { version: string | null; units: (string | null)[] }
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
  ensure(
    run('systemd-run', [...base, '-p', 'process.version']) === 'v24.19.0',
    'Service Node mismatch',
  )
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
async function switchTo(target: Snapshot) {
  for (const unit of [...units].reverse()) {
    const loaded = run('systemctl', ['show', '-p', 'LoadState', '--value', unit])
    if (loaded !== 'not-found') run('systemctl', ['stop', unit])
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
    save: (s: Snapshot) => void
    drain: () => Promise<void>
    switchTo: (s: Snapshot) => Promise<void>
    finish: (s: Snapshot) => void
    clear: () => void
  },
) {
  ops.save(old)
  try {
    if (old.version) await ops.drain()
    await ops.switchTo(target)
    ops.finish(old)
  } catch (error) {
    await ops.switchTo(old)
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
    await switchTo(JSON.parse(fs.readFileSync(pending, 'utf8')))
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
  await activate(old, target, {
    save: (s) => atomic(pending, JSON.stringify(s)),
    drain: async () => {
      if (action !== '--rollback') return drain()
      try {
        await drain()
      } catch {
        console.error('Rolling back unavailable broker')
      }
    },
    switchTo,
    finish: (s) => atomic(previous, JSON.stringify(s)),
    clear: () => clear(pending),
  })
  console.log('Ready: ' + target.version)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
