#!/usr/bin/env bash
# Tests the operator-held-key backup: backup.sh --encrypt --direct on the host side, restore-encrypted.sh on the operator
# side. Linux; needs age (age-keygen), tar, Node 24 and a tmpfs at /dev/shm. Fails, not skips, when one is missing.
# Uses a throwaway key and a throwaway vault only. The systemd (root) path is tested by scripts/backup-age-systemd-test.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "backup-age-test: FAIL: $*" >&2; exit 1; }
command -v age >/dev/null && command -v age-keygen >/dev/null || fail "age and age-keygen are required"
[ "$(stat -f -c %T /dev/shm 2>/dev/null)" = tmpfs ] || fail "a tmpfs at /dev/shm is required"
node_bin=$(command -v node)
t=$(mktemp -d); shm=$(mktemp -d /dev/shm/op-backup-age.XXXXXXXX)
trap 'rm -rf -- "${t:?}" "${shm:?}"' EXIT
export OPENPASSWORD_NODE=$node_bin OPENPASSWORD_HOME=$t/data
mkdir -m 0700 "$t/data" "$shm/stage"
export OPENPASSWORD_BACKUP_STAGE=$shm/stage
printf 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n' > "$t/swaps"   # no swap
export OPENPASSWORD_BACKUP_SWAPS_FILE=$t/swaps
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
empty_stage() { [ -z "$(ls -A "$shm/stage")" ]; }
backup() { bash deploy/backup/backup.sh --encrypt --direct "$@"; }
restore() { OPENPASSWORD_BACKUP_IDENTITY=$t/id.txt bash deploy/backup/restore-encrypted.sh "$@"; }

# 1. A good run: ciphertext only, nothing readable, stage empty afterwards.
backup > "$t/out.age" || fail "encrypted backup"
[ -s "$t/out.age" ] || fail "no ciphertext was written"
if grep -qa 'sealed-value\|test-master-key\|test-token\|SQLite format' "$t/out.age"; then fail "plain text in the ciphertext"; fi
empty_stage || fail "the staged snapshot was left behind after success"

# 2. The operator side restores it and the vault checks out.
mkdir -m 0700 "$t/restored"
restore "$t/out.age" "$t/restored" >/dev/null || fail "restore"
[ "$("$node_bin" "$t/read.mjs" "$t/restored")" = sealed-value ] || fail "restored row differs"
cmp -s "$t/data/master.key" "$t/restored/master.key" || fail "restored master.key differs"
cmp -s "$t/data/operator.token" "$t/restored/operator.token" || fail "restored operator.token differs"

# 3. Restore refusals leave the target empty: wrong key, truncated file, non-empty target, loose key permissions.
age-keygen -o "$t/other.txt" >/dev/null 2>&1; chmod 600 "$t/other.txt"
mkdir -m 0700 "$t/r2"
OPENPASSWORD_BACKUP_IDENTITY=$t/other.txt bash deploy/backup/restore-encrypted.sh "$t/out.age" "$t/r2" >/dev/null 2>&1 && fail "a wrong key was accepted"
[ -z "$(ls -A "$t/r2")" ] || fail "a wrong key left files in the target"
head -c 300 "$t/out.age" > "$t/short.age"
restore "$t/short.age" "$t/r2" >/dev/null 2>&1 && fail "a truncated file was accepted"
[ -z "$(ls -A "$t/r2")" ] || fail "a truncated file left files in the target"
restore "$t/out.age" "$t/restored" >/dev/null 2>&1 && fail "restore wrote into a non-empty directory"
chmod 644 "$t/id.txt"
restore "$t/out.age" "$t/r2" >/dev/null 2>&1 && fail "a world-readable key was accepted"
chmod 600 "$t/id.txt"

# 3b. A validly encrypted archive with unsafe or unexpected members is refused before anything is extracted.
rcp=$(cat "$t/recipient")
evil() { # name, then the commands that build the archive in $t/ev
  local name=$1; shift
  rm -rf "$t/ev"; mkdir "$t/ev"; ( cd "$t/ev" && "$@" ) || fail "could not build the $name archive"
  age -r "$rcp" -o "$t/$name.age" "$t/ev/$name.tar" || fail "could not encrypt the $name archive"
  restore "$t/$name.age" "$t/r2" >/dev/null 2>&1 && fail "the $name archive was accepted"
  [ -z "$(ls -A "$t/r2")" ] || fail "the $name archive left files in the target"
}
good() { cp "$t/data/vault.sqlite" vault.sqlite; cp "$t/data/master.key" master.key; }
evil symlink bash -c "ln -s /etc/hostname vault.sqlite; cp '$t/data/master.key' master.key; tar -cf symlink.tar vault.sqlite master.key"
evil extra bash -c "cp '$t/data/vault.sqlite' vault.sqlite; cp '$t/data/master.key' master.key; echo x > extra; tar -cf extra.tar vault.sqlite master.key extra"
evil duplicate bash -c "cp '$t/data/vault.sqlite' vault.sqlite; cp '$t/data/master.key' master.key; tar -cf duplicate.tar vault.sqlite master.key; tar -rf duplicate.tar vault.sqlite"
evil dirmember bash -c "cp '$t/data/vault.sqlite' vault.sqlite; mkdir master.key; tar -cf dirmember.tar vault.sqlite master.key"
evil nomaster bash -c "cp '$t/data/vault.sqlite' vault.sqlite; tar -cf nomaster.tar vault.sqlite"
evil traversal bash -c "cp '$t/data/vault.sqlite' vault.sqlite; cp '$t/data/master.key' master.key; tar -cf traversal.tar vault.sqlite master.key --transform='s,^master.key,../master.key,'"

# 4. The host refuses before any snapshot when the recipient file or the staging place is unsuitable.
refuses() { local what=$1; shift; "$@" > "$t/refused.out" 2>/dev/null && fail "$what was accepted"; [ ! -s "$t/refused.out" ] || fail "$what wrote output"; empty_stage || fail "$what left a staged snapshot"; }
refuses "a missing recipient file" env OPENPASSWORD_BACKUP_RECIPIENT=$t/none bash deploy/backup/backup.sh --encrypt --direct
cp "$t/id.txt" "$t/withsecret"
refuses "a private key in the recipient file" env OPENPASSWORD_BACKUP_RECIPIENT=$t/withsecret bash deploy/backup/backup.sh --encrypt --direct
printf 'not-a-key\n' > "$t/junk"
refuses "junk in the recipient file" env OPENPASSWORD_BACKUP_RECIPIENT=$t/junk bash deploy/backup/backup.sh --encrypt --direct
printf '# AGE-SECRET-KEY-1EXAMPLEEXAMPLEEXAMPLE\n%s\n' "$rcp" > "$t/commented"
refuses "a commented private key in the recipient file" env OPENPASSWORD_BACKUP_RECIPIENT=$t/commented bash deploy/backup/backup.sh --encrypt --direct
printf '%s\nnot-a-key\n' "$rcp" > "$t/mixed"
refuses "a stray line in the recipient file" env OPENPASSWORD_BACKUP_RECIPIENT=$t/mixed bash deploy/backup/backup.sh --encrypt --direct
: > "$t/empty"
refuses "an empty recipient file" env OPENPASSWORD_BACKUP_RECIPIENT=$t/empty bash deploy/backup/backup.sh --encrypt --direct
cp "$t/recipient" "$t/gw"; chmod 664 "$t/gw"
refuses "a group-writable recipient file" env OPENPASSWORD_BACKUP_RECIPIENT=$t/gw bash deploy/backup/backup.sh --encrypt --direct
ln -s "$t/recipient" "$t/link"
refuses "a symlinked recipient file" env OPENPASSWORD_BACKUP_RECIPIENT=$t/link bash deploy/backup/backup.sh --encrypt --direct
mkdir "$t/dir"
refuses "a directory as the recipient file" env OPENPASSWORD_BACKUP_RECIPIENT=$t/dir bash deploy/backup/backup.sh --encrypt --direct
# Staging must be memory-only.
if [ "$(stat -f -c %T /var/tmp 2>/dev/null)" != tmpfs ] && [ "$(stat -f -c %T /var/tmp 2>/dev/null)" != ramfs ]; then
  refuses "a staging directory on disk" env OPENPASSWORD_BACKUP_STAGE=/var/tmp bash deploy/backup/backup.sh --encrypt --direct
fi
printf 'Filename\tType\tSize\tUsed\tPriority\n/dev/sda2\tpartition\t1000\t0\t-2\n' > "$t/swaps.disk"
refuses "tmpfs with an unencrypted swap partition" env OPENPASSWORD_BACKUP_SWAPS_FILE=$t/swaps.disk bash deploy/backup/backup.sh --encrypt --direct
printf 'Filename\tType\tSize\tUsed\tPriority\n/swapfile\tfile\t1000\t0\t-2\n' > "$t/swaps.file"
refuses "tmpfs with an unencrypted swap file" env OPENPASSWORD_BACKUP_SWAPS_FILE=$t/swaps.file bash deploy/backup/backup.sh --encrypt --direct
refuses "an unreadable swap table" env OPENPASSWORD_BACKUP_SWAPS_FILE=$t/no-such-file bash deploy/backup/backup.sh --encrypt --direct
printf 'Filename\tType\tSize\tUsed\tPriority\n/dev/zram0\tpartition\t1000\t0\t100\n' > "$t/swaps.zram"
OPENPASSWORD_BACKUP_SWAPS_FILE=$t/swaps.zram backup > "$t/zram.age" || fail "zram swap should be allowed"
[ -s "$t/zram.age" ] || fail "zram run wrote nothing"

# 5. The staged plain snapshot is gone after a failure and after termination.
mkdir "$t/bin"
printf '#!/bin/sh\ncat >/dev/null\nexit 1\n' > "$t/bin/age"; chmod 700 "$t/bin/age"
refuses "an encryption failure" env OPENPASSWORD_BACKUP_AGE=$t/bin/age bash deploy/backup/backup.sh --encrypt --direct
printf '#!/bin/sh\nsleep 30\n' > "$t/bin/age"
# Terminate the whole process group, as Ctrl-C or a service stop does, without killing any child by hand.
command -v setsid >/dev/null || fail "setsid is required"
OPENPASSWORD_BACKUP_AGE=$t/bin/age setsid bash deploy/backup/backup.sh --encrypt --direct > "$t/o6" 2>/dev/null &
pid=$!
for _ in $(seq 1 100); do
  [ -s "$shm/stage"/*/vault.sqlite ] 2>/dev/null && break
  sleep 0.1
done
[ -s "$shm/stage"/*/vault.sqlite ] 2>/dev/null || fail "the snapshot was not staged in time to test termination"
kill -TERM -- "-$pid"
wait "$pid" 2>/dev/null || true
sleep 0.5
empty_stage || fail "the staged snapshot was left behind after termination"

# 6. The host side needs no borg and no private key.
( unset BORG_REPO BORG_PASSCOMMAND; OPENPASSWORD_BACKUP_ENV=/nonexistent backup >/dev/null ) || fail "encrypt mode needs borg settings"
# 7. The root path (snapshot and encryption inside one systemd unit) is part of this test. It needs root and systemd, and a
# staging host's disposable vault (OPENPASSWORD_HOME); set OPENPASSWORD_SKIP_SYSTEMD_PATH=1 only to say, loudly, that it was NOT run.
if [ "$(id -u)" = 0 ] && [ -d /run/systemd/system ]; then
  env -u OPENPASSWORD_BACKUP_STAGE -u OPENPASSWORD_BACKUP_SWAPS_FILE -u OPENPASSWORD_BACKUP_RECIPIENT -u OPENPASSWORD_HOME \
    OPENPASSWORD_HOME="${OPENPASSWORD_SYSTEMD_HOME:-/var/lib/openpassword}" bash scripts/backup-age-systemd-test.sh || fail "the root systemd path"
elif [ "${OPENPASSWORD_SKIP_SYSTEMD_PATH:-}" = 1 ]; then
  echo "backup-age-test: NOTE: the root systemd path was NOT tested (OPENPASSWORD_SKIP_SYSTEMD_PATH=1)" >&2
else
  fail "the root systemd path was not tested: run as root on a staging host with systemd, or set OPENPASSWORD_SKIP_SYSTEMD_PATH=1 to record that it was not run"
fi
echo "backup-age-test: ok"
