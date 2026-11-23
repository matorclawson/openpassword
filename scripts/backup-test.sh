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
"$node_bin" --input-type=module -e '
import { DatabaseSync } from "node:sqlite"
const db = new DatabaseSync(process.argv[1] + "/vault.sqlite")
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('sealed-value')`)
db.close()
' "$t/data"
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
got=$("$node_bin" --input-type=module -e '
import { DatabaseSync } from "node:sqlite"
const db = new DatabaseSync(process.argv[1] + "/vault.sqlite", { readOnly: true })
console.log(db.prepare("SELECT a FROM t").get().a)
' "$t/restored")
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
echo "backup-test: ok"
