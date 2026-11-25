#!/usr/bin/env bash
# Tests deploy/backup/backup.sh and restore.sh against a local borg repository. Linux only; needs borg
# and Node 24. Fails (does not skip) when borg is missing, so a green run means the restore was proven.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v borg >/dev/null || { echo "backup-test: borg is required" >&2; exit 1; }
node_bin=$(command -v node)
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
export OPENPASSWORD_NODE=$node_bin OPENPASSWORD_HOME=$t/data OPENPASSWORD_BACKUP_ENV=$t/backup.env
export BORG_BASE_DIR=$t/borg-base BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK=no
mkdir -m 0700 "$t/data"
# The fixture scripts are quoted heredocs written to files, so no shell quoting touches the SQL.
cat > "$t/seed.mjs" <<'JS'
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.argv[2] + '/vault.sqlite')
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('sealed-value')")
const row = db.prepare('SELECT a FROM t').get()
if (row?.a !== 'sealed-value') throw new Error('the seeded row does not read back: ' + JSON.stringify(row))
db.close()
JS
cat > "$t/read.mjs" <<'JS'
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.argv[2] + '/vault.sqlite', { readOnly: true })
console.log(db.prepare('SELECT a FROM t').get().a)
JS
"$node_bin" "$t/seed.mjs" "$t/data"
printf 'test-master-key\n' > "$t/data/master.key"; printf 'test-token\n' > "$t/data/operator.token"
printf 'correct-passphrase\n' > "$t/pass"; chmod 600 "$t/pass"
printf 'BORG_REPO=%s\nBORG_PASSCOMMAND="cat %s"\n' "$t/repo" "$t/pass" > "$t/backup.env"; chmod 600 "$t/backup.env"
( set -a; . "$t/backup.env"; set +a; borg init --encryption=repokey-blake2 "$t/repo" >/dev/null )

fail() { echo "backup-test: FAIL: $*" >&2; exit 1; }
bash deploy/backup/backup.sh --direct >/dev/null || fail "backup"
archive=$( ( set -a; . "$t/backup.env"; set +a; borg list --short ) | head -1 )
[ -n "$archive" ] || fail "no archive was created"

# The repository is encrypted: the plain text must not appear in it.
if grep -rqa 'sealed-value\|test-master-key' "$t/repo"; then fail "plain text found in the repository"; fi

mkdir -m 0700 "$t/restored"
bash deploy/backup/restore.sh "$archive" "$t/restored" >/dev/null || fail "restore"
got=$("$node_bin" "$t/read.mjs" "$t/restored")
[ "$got" = sealed-value ] || fail "restored row differs"
cmp -s "$t/data/master.key" "$t/restored/master.key" || fail "restored master.key differs"

# Refusals.
bash deploy/backup/restore.sh "$archive" "$t/restored" >/dev/null 2>&1 && fail "restore overwrote a non-empty directory"
printf 'BORG_REPO=%s\nBORG_PASSCOMMAND="cat %s"\nBORG_PASSPHRASE=x\n' "$t/repo" "$t/pass" > "$t/bad.env"; chmod 600 "$t/bad.env"
OPENPASSWORD_BACKUP_ENV=$t/bad.env bash deploy/backup/backup.sh --direct >/dev/null 2>&1 && fail "a plain passphrase in the env was accepted"
chmod 644 "$t/backup.env"
bash deploy/backup/backup.sh --direct >/dev/null 2>&1 && fail "a world-readable env file was accepted"
chmod 600 "$t/backup.env"
printf 'wrong\n' > "$t/pass"
bash deploy/backup/backup.sh --direct >/dev/null 2>&1 && fail "a wrong passphrase was accepted"

# Operator-run pull backup: a stand-in for ssh runs the host side locally; borg and the key stay on this side.
printf 'correct-passphrase\n' > "$t/pass"
cat > "$t/fake-ssh" <<'SH'
#!/usr/bin/env bash
# args: <host> <remote command words>; run the host side locally in stream mode
shift
exec bash "$OPENPASSWORD_TEST_ROOT/deploy/backup/backup.sh" --stream --direct
SH
cat > "$t/broken-ssh" <<'SH'
#!/usr/bin/env bash
# a stream that dies halfway
shift
bash "$OPENPASSWORD_TEST_ROOT/deploy/backup/backup.sh" --stream --direct | head -c 700
exit 1
SH
chmod 700 "$t/fake-ssh" "$t/broken-ssh"
export OPENPASSWORD_TEST_ROOT=$PWD
OPENPASSWORD_BACKUP_HOST=operator@host.example.com OPENPASSWORD_BACKUP_SSH="$t/fake-ssh" \
  bash deploy/backup/pull.sh >/dev/null || fail "pull backup"
pulled=$( ( set -a; . "$t/backup.env"; set +a; borg list --short ) | tail -1 )
[ "$pulled" != "$archive" ] || fail "pull wrote no new archive"
if grep -rqa 'sealed-value\|test-master-key' "$t/repo"; then fail "plain text found in the repository after pull"; fi
mkdir -m 0700 "$t/restored-pull"
bash deploy/backup/restore.sh "$pulled" "$t/restored-pull" >/dev/null || fail "restore of a pulled archive"
[ "$("$node_bin" "$t/read.mjs" "$t/restored-pull")" = sealed-value ] || fail "pulled restore row differs"
cmp -s "$t/data/master.key" "$t/restored-pull/master.key" || fail "pulled master.key differs"
count=$( ( set -a; . "$t/backup.env"; set +a; borg list --short ) | wc -l | tr -d ' ')
OPENPASSWORD_BACKUP_HOST=operator@host.example.com OPENPASSWORD_BACKUP_SSH="$t/broken-ssh" \
  bash deploy/backup/pull.sh >/dev/null 2>&1 && fail "a broken stream was accepted"
[ "$( ( set -a; . "$t/backup.env"; set +a; borg list --short ) | wc -l | tr -d ' ')" = "$count" ] || fail "a failed pull left an archive"
OPENPASSWORD_BACKUP_HOST=operator@host.example.com OPENPASSWORD_BACKUP_SSH="$t/fake-ssh" OPENPASSWORD_BACKUP_ENV="$t/bad.env" \
  bash deploy/backup/pull.sh >/dev/null 2>&1 && fail "pull accepted a plain passphrase in the env"
# The host side needs no borg, no env file and no key.
( unset BORG_REPO BORG_PASSCOMMAND; OPENPASSWORD_BACKUP_ENV=/nonexistent bash deploy/backup/backup.sh --stream --direct | tar -tf - | grep -qx vault.sqlite ) || fail "stream mode needs the backup settings"
echo "backup-test: ok"
