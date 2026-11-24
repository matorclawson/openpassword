import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { activate, snapshotStore, restoreStore } from '../deploy/upgrade.ts'
const old = { version: '0.2.0', units: ['host-node-broker', 'host-node-web'] }
const next = { version: '0.4.0', units: ['bundled-node-broker', 'bundled-node-web'] }
type Rec = typeof old & { store?: string | null }
for (const failure of ['none', 'drain', 'readiness', 'restore'])
  test('archive activation: ' + failure, async () => {
    let current = old,
      pending: Rec | null = null,
      previous: typeof old | null = null
    const result = activate(old, next, {
      save: (s) => {
        pending = s as Rec
      },
      drain: async () => {
        if (failure === 'drain') throw Error('drain')
      },
      stop: () => {},
      backup: () => null,
      switchTo: async (s) => {
        assert.deepEqual(pending, old)
        current = s as typeof old
        if (s === next && ['readiness', 'restore'].includes(failure)) throw Error('bad candidate')
        if (s === old && failure === 'restore') throw Error('failed restore')
      },
      finish: (s) => {
        previous = s as typeof old
      },
      clear: () => {
        pending = null
      },
      discard: () => {},
    })
    if (failure === 'none') {
      await result
      assert.deepEqual(current, next)
      assert.deepEqual(previous, old)
    } else {
      await assert.rejects(result)
      assert.deepEqual(current, old)
    }
    assert.deepEqual(pending, failure === 'restore' ? old : null)
  })

// A fake state directory: the "old" schema, a master key, and a WAL sidecar-free stopped database.
function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'op-upg-'))
  const data = join(dir, 'data')
  fs.mkdirSync(data)
  const db = new DatabaseSync(join(data, 'vault.sqlite'))
  db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE items(id TEXT PRIMARY KEY, v TEXT); INSERT INTO items VALUES (\'a\',\'old-value\'); PRAGMA user_version=1')
  db.close()
  fs.writeFileSync(join(data, 'master.key'), 'old-master-key\n', { mode: 0o600 })
  fs.writeFileSync(join(data, 'operator.token'), 'old-token\n', { mode: 0o600 })
  return { dir, data, snap: join(dir, 'snap') }
}
const schema = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return {
      version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      columns: (db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name),
      // node:sqlite rows have a null prototype; compare plain copies.
      rows: db.prepare('SELECT * FROM items ORDER BY id').all().map((r) => ({ ...r })),
    }
  } finally {
    db.close()
  }
}
// The candidate's migration: new schema, a rewritten wrapped master key, an extra file.
function migrate(data: string) {
  const db = new DatabaseSync(join(data, 'vault.sqlite'))
  db.exec("ALTER TABLE items ADD COLUMN owner TEXT; UPDATE items SET v='migrated'; INSERT INTO items VALUES ('b','new','x'); PRAGMA user_version=2")
  db.close()
  fs.writeFileSync(join(data, 'master.key'), 'wrapped-master-key\n', { mode: 0o600 })
  fs.writeFileSync(join(data, 'extra.state'), 'new\n')
}

test('a forced failure after migration restores the old schema, keys and data for the old release', async () => {
  const { dir, data, snap } = fixture()
  try {
    const before = schema(join(data, 'vault.sqlite'))
    let current = old,
      pending: Rec | null = null,
      discarded: string | null = null
    await assert.rejects(
      activate(old, next, {
        save: (s) => {
          pending = s as Rec
        },
        drain: async () => {},
        stop: () => {},
        backup: () => {
          snapshotStore(data, snap)
          return snap
        },
        switchTo: async (s, restoreFrom) => {
          if (s === next) {
            // The candidate started, migrated the store, then failed readiness.
            assert.equal(pending?.store, snap, 'the snapshot path is recorded before the candidate starts')
            migrate(data)
            throw Error('readiness failed')
          }
          assert.equal(restoreFrom, snap)
          if (restoreFrom) restoreStore(data, restoreFrom)
          current = s as typeof old
        },
        finish: () => assert.fail('must not finish'),
        clear: () => {
          pending = null
        },
        discard: (store) => {
          discarded = store
        },
      }),
      /readiness failed/,
    )
    assert.deepEqual(current, old)
    assert.equal(discarded, snap)
    assert.deepEqual(schema(join(data, 'vault.sqlite')), before)
    assert.equal(before.version, 1)
    assert.ok(!before.columns.includes('owner'))
    assert.equal(fs.readFileSync(join(data, 'master.key'), 'utf8'), 'old-master-key\n')
    assert.ok(!fs.existsSync(join(data, 'extra.state')), 'files the candidate created are removed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an interrupted activation is recovered with the recorded vault copy', async () => {
  const { dir, data, snap } = fixture()
  try {
    snapshotStore(data, snap)
    migrate(data)
    // pending.json carried { ...old, store: snap }; recovery restores it before the old release starts.
    restoreStore(data, snap)
    const s = schema(join(data, 'vault.sqlite'))
    assert.equal(s.version, 1)
    assert.deepEqual(s.rows, [{ id: 'a', v: 'old-value' }])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the snapshot is refused when the vault is corrupt or the directory holds a link', () => {
  const a = fixture()
  try {
    fs.writeFileSync(join(a.data, 'vault.sqlite'), 'not a database'.repeat(100))
    assert.throws(() => snapshotStore(a.data, a.snap), /integrity|database/i)
  } finally {
    fs.rmSync(a.dir, { recursive: true, force: true })
  }
  const b = fixture()
  try {
    fs.symlinkSync('/etc/hostname', join(b.data, 'link'))
    assert.throws(() => snapshotStore(b.data, b.snap), /Unexpected entry/)
  } finally {
    fs.rmSync(b.dir, { recursive: true, force: true })
  }
})
