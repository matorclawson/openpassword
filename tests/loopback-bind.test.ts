import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')

// Everything that dials the console or the broker uses the literal 127.0.0.1, so everything that listens
// there must bind that exact address. `localhost` may resolve to ::1 only (Node 24), which refuses 127.0.0.1.
test('the console unit binds the address its callers dial', () => {
  const exec = read('deploy/systemd/openpassword-web.service').match(/^ExecStart=.*\bnext start\b(.*)$/m)
  assert.ok(exec, 'the web unit runs next start')
  const host = exec[1].match(/(?:^|\s)-H\s+(\S+)/)?.[1]
  assert.equal(host, '127.0.0.1', 'the web unit must bind 127.0.0.1, not ' + host)
  assert.match(exec[1], /(?:^|\s)-p\s+3000(?:\s|$)/)
})

test('the npm scripts bind the same address as the unit', () => {
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
  for (const name of ['dev', 'start']) {
    const host = scripts[name].match(/next (?:dev|start)\b.*?-H\s+(\S+?)["\s]/)?.[1] ?? scripts[name].match(/-H\s+(\S+)/)?.[1]
    assert.equal(host?.replace(/\\?"$/, ''), '127.0.0.1', name + ' must bind 127.0.0.1')
  }
})

test('the console rewrites and the broker use the same loopback address', () => {
  const rewrites = [...read('next.config.ts').matchAll(/http:\/\/([0-9.]+):/g)].map((m) => m[1])
  assert.ok(rewrites.length >= 3)
  for (const h of rewrites) assert.equal(h, '127.0.0.1')
  assert.match(read('server/main.ts'), /host:\s*'127\.0\.0\.1'/)
})

test('the activation controller probes the console on the address the unit binds', () => {
  const m = read('deploy/upgrade.ts').match(/return 'http:\/\/([^:']+):' \+ port/)
  assert.equal(m?.[1], '127.0.0.1', 'deploy/upgrade.ts must probe 127.0.0.1')
})
