// Consistent copy of the vault for backup. Usage: node snapshot.mjs <data-dir> <out-dir>
// Uses SQLite's online backup, so it is safe while the broker runs. It must run as the identity
// that owns the data directory (opening a WAL database can create or change its -shm/-wal files).
import { DatabaseSync, backup } from 'node:sqlite'
import { copyFileSync, existsSync, statSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
const [dir, out] = process.argv.slice(2)
if (!dir || !out) throw Error('usage: snapshot.mjs <data-dir> <out-dir>')
if (!existsSync(join(dir, 'vault.sqlite'))) throw Error('no vault.sqlite in the data directory')
if (!existsSync(join(dir, 'master.key'))) throw Error('no master.key in the data directory')
const src = new DatabaseSync(join(dir, 'vault.sqlite'))
try {
  await backup(src, join(out, 'vault.sqlite'))
} finally {
  src.close()
}
for (const f of ['master.key', 'operator.token']) {
  if (!existsSync(join(dir, f))) continue
  copyFileSync(join(dir, f), join(out, f))
  chmodSync(join(out, f), 0o600)
}
const snap = new DatabaseSync(join(out, 'vault.sqlite'), { readOnly: true })
const check = snap.prepare('PRAGMA integrity_check').get()
snap.close()
if (!check || Object.values(check)[0] !== 'ok') throw Error('the snapshot failed its integrity check')
console.log(JSON.stringify({ ok: true, vault_bytes: statSync(join(out, 'vault.sqlite')).size }))
