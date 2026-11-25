#!/usr/bin/env bash
# Tests the operator-held-key backup: backup.sh --encrypt on the host side, restore-encrypted.sh on the operator side.
# Linux; needs age (age-keygen), tar and Node 24. Fails, not skips, when age is missing. Uses a throwaway key and a
# throwaway vault only.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "backup-age-test: FAIL: $*" >&2; exit 1; }
command -v age >/dev/null && command -v age-keygen >/dev/null || fail "age and age-keygen are required"
node_bin=$(command -v node)
t=$(mktemp -d); trap 'rm -rf -- "${t:?}"' EXIT
export OPENPASSWORD_NODE=$node_bin OPENPASSWORD_HOME=$t/data
mkdir -m 0700 "$t/data" "$t/stage"
export OPENPASSWORD_BACKUP_STAGE=$t/stage
cat > "$t/seed.mjs" <<'JS'
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.argv[2] + '/vault.sqlite')
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('sealed-value')")
db.close()
JS
cat > "$t/read.mjs" <<'JS'
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.argv[2] + '/vault.sqlite', { readOnly: true })
console.log(db.prepare('SELECT a FROM t').get().a)
JS
"$node_bin" "$t/seed.mjs" "$t/data"
printf 'test-master-key\n' > "$t/data/master.key"; printf 'test-token\n' > "$t/data/operator.token"
age-keygen -o "$t/id.txt" >/dev/null 2>&1; chmod 600 "$t/id.txt"
age-keygen -y "$t/id.txt" > "$t/recipient"
export OPENPASSWORD_BACKUP_RECIPIENT=$t/recipient
empty_stage() { [ -z "$(ls -A "$t/stage")" ]; }

# 1. A good run: ciphertext only, nothing readable, stage empty afterwards.
bash deploy/backup/backup.sh --encrypt --direct > "$t/out.age" || fail "encrypted backup"
[ -s "$t/out.age" ] || fail "no ciphertext was written"
if grep -qa 'sealed-value\|test-master-key\|test-token\|SQLite format' "$t/out.age"; then fail "plain text in the ciphertext"; fi
empty_stage || fail "the staged snapshot was left behind after success"

# 2. The operator side restores it and the vault checks out.
mkdir -m 0700 "$t/restored"
OPENPASSWORD_BACKUP_IDENTITY=$t/id.txt bash deploy/backup/restore-encrypted.sh "$t/out.age" "$t/restored" >/dev/null || fail "restore"
[ "$("$node_bin" "$t/read.mjs" "$t/restored")" = sealed-value ] || fail "restored row differs"
cmp -s "$t/data/master.key" "$t/restored/master.key" || fail "restored master.key differs"
cmp -s "$t/data/operator.token" "$t/restored/operator.token" || fail "restored operator.token differs"

# 3. Restore refusals leave the target empty: wrong key, truncated file, non-empty target, loose key permissions.
age-keygen -o "$t/other.txt" >/dev/null 2>&1; chmod 600 "$t/other.txt"
mkdir -m 0700 "$t/r2"
OPENPASSWORD_BACKUP_IDENTITY=$t/other.txt bash deploy/backup/restore-encrypted.sh "$t/out.age" "$t/r2" >/dev/null 2>&1 && fail "a wrong key was accepted"
[ -z "$(ls -A "$t/r2")" ] || fail "a wrong key left files in the target"
head -c 300 "$t/out.age" > "$t/short.age"
OPENPASSWORD_BACKUP_IDENTITY=$t/id.txt bash deploy/backup/restore-encrypted.sh "$t/short.age" "$t/r2" >/dev/null 2>&1 && fail "a truncated file was accepted"
[ -z "$(ls -A "$t/r2")" ] || fail "a truncated file left files in the target"
OPENPASSWORD_BACKUP_IDENTITY=$t/id.txt bash deploy/backup/restore-encrypted.sh "$t/out.age" "$t/restored" >/dev/null 2>&1 && fail "restore wrote into a non-empty directory"
chmod 644 "$t/id.txt"
OPENPASSWORD_BACKUP_IDENTITY=$t/id.txt bash deploy/backup/restore-encrypted.sh "$t/out.age" "$t/r2" >/dev/null 2>&1 && fail "a world-readable key was accepted"
chmod 600 "$t/id.txt"

# 4. The host refuses before any snapshot when the recipient is missing, holds a private key, or holds junk.
OPENPASSWORD_BACKUP_RECIPIENT=$t/none bash deploy/backup/backup.sh --encrypt --direct > "$t/o1" 2>/dev/null && fail "a missing recipient file was accepted"
[ ! -s "$t/o1" ] || fail "output was written without a recipient"
cp "$t/id.txt" "$t/withsecret"
OPENPASSWORD_BACKUP_RECIPIENT=$t/withsecret bash deploy/backup/backup.sh --encrypt --direct > "$t/o2" 2>/dev/null && fail "a private key in the recipient file was accepted"
printf 'not-a-key\n' > "$t/junk"
OPENPASSWORD_BACKUP_RECIPIENT=$t/junk bash deploy/backup/backup.sh --encrypt --direct > "$t/o3" 2>/dev/null && fail "junk in the recipient file was accepted"
printf '%s\nnot-a-key\n' "$(cat "$t/recipient")" > "$t/mixed"
OPENPASSWORD_BACKUP_RECIPIENT=$t/mixed bash deploy/backup/backup.sh --encrypt --direct > "$t/o4" 2>/dev/null && fail "a stray line in the recipient file was accepted"
empty_stage || fail "a refusal left a staged snapshot"

# 5. The staged plain snapshot is gone after a failure and after termination.
mkdir "$t/bin"
printf '#!/bin/sh\ncat >/dev/null\nexit 1\n' > "$t/bin/age"; chmod 700 "$t/bin/age"
PATH=$t/bin:$PATH bash deploy/backup/backup.sh --encrypt --direct > "$t/o5" 2>/dev/null && fail "an encryption failure was accepted"
empty_stage || fail "the staged snapshot was left behind after an encryption failure"
printf '#!/bin/sh\nsleep 30\n' > "$t/bin/age"
PATH=$t/bin:$PATH bash deploy/backup/backup.sh --encrypt --direct > "$t/o6" 2>/dev/null &
pid=$!
for _ in $(seq 1 100); do
  [ -s "$t/stage"/*/vault.sqlite ] 2>/dev/null && break
  sleep 0.1
done
[ -s "$t/stage"/*/vault.sqlite ] 2>/dev/null || fail "the snapshot was not staged in time to test termination"
kill -TERM "$pid"; pkill -P "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
sleep 0.5
empty_stage || fail "the staged snapshot was left behind after termination"

# 6. The host side needs no borg and no private key.
( unset BORG_REPO BORG_PASSCOMMAND; PATH=$(dirname "$node_bin"):$(dirname "$(command -v age)"):/usr/bin:/bin OPENPASSWORD_BACKUP_ENV=/nonexistent bash deploy/backup/backup.sh --encrypt --direct >/dev/null ) || fail "encrypt mode needs borg settings"
echo "backup-age-test: ok"
