import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const opaque = () => randomBytes(32).toString('base64url')
export const digest = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
function persistent(path: string, create: () => string) {
  try {
    writeFileSync(path, create(), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return readFileSync(path, 'utf8').trim()
}
function encrypt(key: Buffer, data: Buffer, aad: string) {
  const iv = randomBytes(12),
    c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad))
  return Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()]).toString('base64')
}
function decrypt(key: Buffer, str: string, aad: string) {
  const b = Buffer.from(str, 'base64'),
    d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(b.subarray(-16))
  return Buffer.concat([d.update(b.subarray(12, -16)), d.final()])
}
export function store(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (existsSync(join(dir, 'vault.sqlite')) && !existsSync(join(dir, 'master.key')))
    throw Error('Restore master.key before opening the vault')
  const key = Buffer.from(
    persistent(join(dir, 'master.key'), () => randomBytes(32).toString('hex')),
    'hex',
  )
  if (key.length !== 32) throw Error('Invalid master key')
  const admin = digest(persistent(join(dir, 'operator.token'), opaque))
  const db = new DatabaseSync(join(dir, 'vault.sqlite'))
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, label TEXT NOT NULL);
    INSERT OR IGNORE INTO workspaces VALUES('default','My workspace');
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, tenant TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, tenant TEXT NOT NULL,provider TEXT NOT NULL,label TEXT NOT NULL,identity TEXT NOT NULL,revision INTEGER NOT NULL,secret TEXT NOT NULL,active INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS connections_tenant ON connections(tenant);
    CREATE TABLE IF NOT EXISTS pairs(id TEXT PRIMARY KEY,code TEXT UNIQUE,user_code TEXT UNIQUE,label TEXT,expires INTEGER, grant_id TEXT);
    CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,tenant TEXT,label TEXT,connection_id TEXT,ops TEXT,expires INTEGER,access TEXT UNIQUE,refresh TEXT UNIQUE,access_until INTEGER,active INTEGER);
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,tenant TEXT,actor TEXT,conn TEXT,op TEXT,idem TEXT,hash TEXT,revision INTEGER,state TEXT,preview TEXT,outcome TEXT,created INTEGER, UNIQUE(actor,conn,idem));
    CREATE INDEX IF NOT EXISTS runs_pending ON runs(tenant,state,created);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,tenant TEXT,action TEXT,subject TEXT,at INTEGER);
    CREATE INDEX IF NOT EXISTS events_tenant ON events(tenant,id);
  `)
  function seal(value: unknown, context: string) {
    const dek = randomBytes(32)
    return (
      encrypt(key, dek, 'key/' + context) +
      '.' +
      encrypt(dek, Buffer.from(JSON.stringify(value)), 'value/' + context)
    )
  }
  function open(str: string, context: string) {
    const [wrapped, data] = str.split('.')
    return JSON.parse(
      decrypt(decrypt(key, wrapped, 'key/' + context), data, 'value/' + context).toString(),
    )
  }
  return { db, admin, seal, open }
}
