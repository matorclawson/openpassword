#!/usr/bin/env bash
# Restore a backup archive into an EMPTY directory and check it. It never touches a live data directory:
# the operator stops the service and moves the restored files into place afterwards.
#   deploy/backup/restore.sh <archive-name> <empty-target-dir>
# Uses the same env file as backup.sh (BORG_REPO, BORG_PASSCOMMAND).
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
NODE=${OPENPASSWORD_NODE:-/opt/openpassword/current/node/bin/node}
ENVF=${OPENPASSWORD_BACKUP_ENV:-/etc/openpassword/backup.env}
archive=${1:-}; target=${2:-}
[ -n "$archive" ] && [ -n "$target" ] || { echo "restore: usage: restore.sh <archive-name> <empty-target-dir>" >&2; exit 2; }
command -v borg >/dev/null || { echo "restore: borg is not installed" >&2; exit 1; }
[ -x "$NODE" ] || { echo "restore: no executable Node at $NODE (set OPENPASSWORD_NODE)" >&2; exit 1; }
[ -f "$ENVF" ] && [ "$(stat -c '%u %a' "$ENVF")" = "$(id -u) 600" ] \
  || { echo "restore: $ENVF must be owned by this user with mode 600" >&2; exit 1; }
set -a; . "$ENVF"; set +a
[ -d "$target" ] && [ -z "$(ls -A "$target")" ] || { echo "restore: $target must be an existing empty directory" >&2; exit 1; }
( cd "$target" && borg extract "::$archive" )
for f in vault.sqlite master.key; do
  [ -s "$target/$f" ] || { echo "restore: the archive lacks $f" >&2; exit 1; }
done
"$NODE" --input-type=module -e '
import { DatabaseSync } from "node:sqlite"
const db = new DatabaseSync(process.argv[1] + "/vault.sqlite", { readOnly: true })
const r = db.prepare("PRAGMA integrity_check").get()
db.close()
if (!r || Object.values(r)[0] !== "ok") { console.error("restore: vault integrity check failed"); process.exit(1) }
' "$target"
echo "restore: $archive restored to $target and the vault passed its integrity check"
