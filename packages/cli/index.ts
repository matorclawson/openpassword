#!/usr/bin/env node
import { OpenPassword, type DeviceTokens } from '@openpassword/client'
import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
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
) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(dir, 'devices.sqlite'))
  db.exec(
    'PRAGMA busy_timeout=95000; CREATE TABLE IF NOT EXISTS identities(origin TEXT PRIMARY KEY,tokens TEXT); BEGIN IMMEDIATE',
  )
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
    if (legacy) save(previous)
    const result = await fn(previous, save)
    db.exec('COMMIT')
    if (legacy) unlinkSync(file)
    return result
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw e
  } finally {
    db.close()
  }
}
async function tokens(revoke = false) {
  return identity(async (previous, save) => {
    if (!previous) throw Error('Pair this device first')
    let current = previous
    if (Date.parse(current.access_expires_at) <= Date.now() + 10000) {
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
  if (!['connections', 'invoke', 'revoke'].includes(cmd))
    throw Error(
      'Usage: openpassword pair [name] | mcp | connections | invoke CONNECTION OPERATION KEY JSON | revoke',
    )
  const t = await tokens(cmd === 'revoke')
  if (cmd === 'revoke') return
  const bound = new OpenPassword(origin, t.access_token)
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
