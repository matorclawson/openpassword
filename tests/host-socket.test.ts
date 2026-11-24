// Exercises the actual CLI and Unix signer under one UID. OS group isolation needs a staging host.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { service } from '../server/service.ts'

test(
  'built CLI enrolls a host, runs the signing socket, pairs an agent and invokes whoami',
  { timeout: 20000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'op-socket-')),
      socket = join(dir, 'host.sock')
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const probe = createServer()
    const listen = once(probe, 'listening')
    probe.listen(socket)
    try {
      await listen
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Unix sockets denied by the execution environment')
        return
      }
      throw e
    }
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const portProbe = createServer()
    portProbe.listen(0, '127.0.0.1')
    await once(portProbe, 'listening')
    const port = (portProbe.address() as { port: number }).port
    await new Promise<void>((resolve) => portProbe.close(() => resolve()))
    const origin = 'http://127.0.0.1:' + port,
      api = service(dir, origin)
    await api.listen({ port, host: '127.0.0.1' })
    t.after(() => api.close())
    const env = {
      ...process.env,
      HOME: dir,
      OPENPASSWORD_BROKER: origin,
      OPENPASSWORD_HOST_SOCKET: socket,
      OPENPASSWORD_AGENT: 'codex',
    }
    const cli = (...args: string[]) =>
      spawn(process.execPath, ['packages/cli/dist/index.js', ...args], { env })
    const post = (url: string, payload: object, cookie = '') =>
      api.inject({ method: 'POST', url, payload, headers: { cookie } })
    const cookie = String(
      (await post('/admin/login', { token: readFileSync(join(dir, 'operator.token'), 'utf8') }))
        .headers['set-cookie'],
    ).split(';')[0]
    const { ticket } = (await post('/admin/hosts', { label: 'test host' }, cookie)).json()
    const enroll = cli('host', 'connect'),
      enrolled = once(enroll, 'exit')
    enroll.stdin.end(ticket + '\n')
    assert.equal((await enrolled)[0], 0)
    const bridge = cli('host', 'serve')
    t.after(() => {
      bridge.kill()
    })
    await once(bridge.stderr, 'data')
    const agent = cli('pair')
    t.after(() => {
      agent.kill()
    })
    const paired = once(agent, 'exit')
    const [line] = await once(agent.stdout, 'data')
    const request = String(line).split(' ')[2]
    const conn = (
      await post(
        '/admin/connections',
        { provider: 'github_read', label: 'test', external_identity: 'test', secret: 'synthetic' },
        cookie,
      )
    ).json().connection_id
    const result = await post(
      '/admin/grants',
      {
        host_request: request,
        connection_id: conn,
        label: 'codex',
        operations: ['github.user.get'],
        hours: 1,
      },
      cookie,
    )
    assert.equal(result.statusCode, 200, result.body)
    assert.equal((await paired)[0], 0)
    const check = cli('whoami'),
      done = once(check, 'exit')
    const [who] = await once(check.stdout, 'data')
    assert.equal(JSON.parse(String(who)).device_id, result.json().device_id)
    assert.equal((await done)[0], 0)
  },
)
