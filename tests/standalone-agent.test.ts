import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { service } from '../server/service.ts'
test(
  'standalone agent pairs and uses its scoped connection over MCP',
  { timeout: 30000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'op-standalone-')),
      api = service(dir, undefined, async () => Response.json({ login: 'fixture', id: 1 }))
    t.after(async () => {
      await api.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const origin = await api.listen({ host: '127.0.0.1', port: 0 })
    const env = { HOME: dir, OPENPASSWORD_BROKER: origin, OPENPASSWORD_AGENT: 'local-codex' }
    const args = [resolve('packages/cli/dist/index.js')]
    const post = (url: string, payload: object, cookie = '') =>
      api.inject({ method: 'POST', url, payload, headers: { cookie } })
    const cookie = String(
      (await post('/admin/login', { token: readFileSync(join(dir, 'operator.token'), 'utf8') }))
        .headers['set-cookie'],
    ).split(';')[0]
    const connection = (
      await post(
        '/admin/connections',
        {
          provider: 'github_read',
          label: 'Engineering',
          external_identity: 'fixture',
          secret: 'private-upstream',
        },
        cookie,
      )
    ).json().connection_id
    const proc = spawn(process.execPath, [...args, 'pair'], { env: { ...env, NODE_ENV: 'test' } })
    t.after(() => {
      proc.kill()
    })
    const exit = once(proc, 'exit')
    const [line] = await once(proc.stdout, 'data')
    const code = String(line).trim().split(' ').pop()
    assert.equal(
      (
        await post(
          '/admin/grants',
          {
            connection_id: connection,
            label: 'local-codex',
            operations: ['github.user.get'],
            hours: 1,
            user_code: code,
          },
          cookie,
        )
      ).statusCode,
      200,
    )
    assert.equal((await exit)[0], 0)
    const client = new Client({ name: 'standalone-harness', version: '1' })
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [...args, 'mcp'], env }),
    )
    t.after(() => client.close())
    assert.deepEqual((await client.listTools()).tools.map((x) => x.name).sort(), [
      'activity',
      'capabilities',
      'chat',
      'connections',
      'invoke',
      'models',
      'whoami',
    ])
    const caps = await client.callTool({ name: 'capabilities', arguments: {} })
    assert.ok(JSON.stringify(caps).includes('github.user.get'))
    const data = await client.callTool({ name: 'connections', arguments: {} })
    assert.ok(JSON.stringify(data).includes(connection))
    const invoked = await client.callTool({
      name: 'invoke',
      arguments: {
        connection_id: connection,
        operation_id: 'github.user.get',
        arguments: {},
        idempotency_key: 'sample',
      },
    })
    assert.ok(!invoked.isError, JSON.stringify(invoked))
    assert.ok(!JSON.stringify(invoked).includes('private-upstream'))
  },
)
