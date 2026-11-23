#!/usr/bin/env node
import { OpenPassword, type DeviceTokens } from '@openpassword/client'
import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [cmd, ...args] = process.argv.slice(2)
const origin = process.env.OPENPASSWORD_BROKER || 'http://127.0.0.1:4141'
const dir = join(homedir(), '.config/openpassword'),
  file = join(dir, Buffer.from(new URL(origin).origin).toString('base64url') + '.json')
process.umask(0o077)
async function identity<T>(
  fn: (
    previous: DeviceTokens | undefined,
    save: (value: DeviceTokens | null) => void,
  ) => Promise<T>,
  readOnly = false,
) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(dir, 'devices.sqlite'))
  db.exec(
    'PRAGMA busy_timeout=95000; CREATE TABLE IF NOT EXISTS identities(origin TEXT PRIMARY KEY,tokens TEXT);',
  )
  db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE')
  const profile = process.env.OPENPASSWORD_AGENT?.trim()
  const key = profile ? JSON.stringify([new URL(origin).origin, profile]) : new URL(origin).origin
  try {
    const record = db.prepare('SELECT tokens FROM identities WHERE origin=?').get(key)
    const legacy = !profile && !record && existsSync(file)
    const previous = record
      ? JSON.parse(String(record.tokens))
      : legacy
        ? JSON.parse(readFileSync(file, 'utf8'))
        : undefined
    const save = (value: DeviceTokens | null) => {
      if (value)
        db.prepare('INSERT OR REPLACE INTO identities VALUES(?,?)').run(key, JSON.stringify(value))
      else db.prepare('DELETE FROM identities WHERE origin=?').run(key)
    }
    if (legacy && !readOnly) save(previous)
    const result = await fn(previous, save)
    db.exec('COMMIT')
    if (legacy && !readOnly) unlinkSync(file)
    return result
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw e
  } finally {
    db.close()
  }
}
async function tokens(revoke = false) {
  if (!revoke) {
    const previous = await identity(async (value) => value, true)
    if (previous && Date.parse(previous.access_expires_at) > Date.now() + 30000) return previous
  }
  return identity(async (previous, save) => {
    if (!previous) throw Error('Pair this device first')
    let current = previous
    if (Date.parse(current.access_expires_at) <= Date.now() + 30000) {
      current = await new OpenPassword(origin).refresh(current.refresh_token)
      save(current)
    }
    if (revoke) {
      await new OpenPassword(origin, current.access_token).request('/v1/device/revoke', {})
      save(null)
    }
    return current
  })
}
async function main() {
  const client = new OpenPassword(origin)
  if (cmd === 'mcp') {
    const { serve } = await import('./mcp.js')
    // Serialize refreshes in this process before acquiring the cross-process SQLite lock.
    let pending: Promise<DeviceTokens> | undefined
    await serve(async () => {
      pending ??= tokens().finally(() => {
        pending = undefined
      })
      return new OpenPassword(origin, (await pending).access_token)
    })
    return
  }
  if (cmd === 'connect') {
    if (args.length) throw Error('Paste the enrollment token at the prompt or provide it on stdin.')
    if (process.stdin.isTTY) process.stderr.write('CLI enrollment token (hidden): ')
    const input = createInterface({
      input: process.stdin,
      terminal: !!process.stdin.isTTY,
      output: new Writable({
        write(_data, _encoding, done) {
          done()
        },
      }),
    })
    let ticket: string
    try {
      const answer = await input[Symbol.asyncIterator]().next()
      ticket = String(answer.value ?? '').trim()
    } finally {
      input.close()
      if (process.stdin.isTTY) process.stderr.write('\n')
    }
    if (!ticket) throw Error('An enrollment token is required.')
    await identity(async (previous, save) => {
      if (previous)
        throw Error(
          'Profile already paired. Choose another OPENPASSWORD_AGENT or revoke this profile first.',
        )
      save(await client.redeem(ticket))
    })
    console.log(
      JSON.stringify(
        await new OpenPassword(origin, (await tokens()).access_token).request('/v1/whoami'),
      ),
    )
    return
  }
  if (cmd === 'pair') {
    const p = await client.pair(args[0] || process.env.OPENPASSWORD_AGENT || 'CLI')
    console.log('Open', p.verification_url, 'and approve code', p.user_code)
    while (Date.now() < Date.parse(p.expires_at)) {
      await new Promise((r) => setTimeout(r, p.interval_seconds * 1000))
      try {
        const pair = await client.redeem(p.device_code)
        await identity(async (_previous, save) => save(pair))
        console.log('Device paired')
        return
      } catch (e) {
        if ((e as { status?: number }).status !== 428) throw e
      }
    }
    throw Error('Pairing expired')
  }
  if (
    ![
      'connections',
      'invoke',
      'revoke',
      'whoami',
      'activity',
      'watch',
      'capabilities',
      'models',
      'chat',
    ].includes(cmd)
  )
    throw Error(
      'Usage: openpassword connect | whoami | activity | watch | capabilities | models | chat MODEL MAX_TOKENS KEY < prompt.txt | pair [name] | mcp | connections | invoke CONNECTION OPERATION KEY JSON | revoke',
    )
  const t = await tokens(cmd === 'revoke')
  if (cmd === 'revoke') return
  const bound = new OpenPassword(origin, t.access_token)
  if (cmd === 'watch') {
    let cursor: number | undefined = args.length ? Number(args[0]) : undefined
    if (
      args.length > 1 ||
      (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
    ) {
      throw Error('Usage: openpassword watch [last-event-id]')
    }
    let delay = 500
    while (true) {
      const live = new OpenPassword(origin, (await tokens()).access_token)
      try {
        const page: { events: unknown[]; cursor: number } = await live.request(
          '/v1/activity' + (cursor === undefined ? '' : '?after=' + cursor),
        )
        for (const event of page.events) console.log(JSON.stringify(event))
        cursor = page.cursor
        delay = 500
      } catch (error) {
        const status = (error as { status?: number }).status
        if (!(error instanceof TypeError || status === 429 || (status && status >= 500)))
          throw error
        await new Promise((done) => setTimeout(done, delay + Math.random() * 250))
        delay = Math.min(10000, delay * 2)
      }
    }
  }
  if (cmd === 'chat') {
    if (args.length !== 3 || process.stdin.isTTY)
      throw Error('Usage: openpassword chat MODEL MAX_TOKENS KEY < prompt.txt')
    console.log(
      JSON.stringify(
        await bound.chat(args[0], readFileSync(0, 'utf8'), Number(args[1]), args[2]),
        null,
        2,
      ),
    )
    return
  }
  if (['whoami', 'activity', 'capabilities', 'models'].includes(cmd)) {
    console.log(JSON.stringify(await bound.request('/v1/' + cmd), null, 2))
    return
  }
  const result =
    cmd === 'connections'
      ? await bound.connections()
      : await bound.invoke(args[0], args[1], JSON.parse(args[3] || '{}'), args[2])
  console.log(JSON.stringify(result, null, 2))
}
main().catch((e) => {
  console.error(e.message)
  process.exitCode = 1
})
