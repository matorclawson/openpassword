#!/usr/bin/env bash
# Open an age-encrypted backup made by `backup.sh --encrypt` and check it. Run this on YOUR machine, with your private key.
# It restores into an EMPTY directory and never touches a live data directory.
#   OPENPASSWORD_BACKUP_IDENTITY=~/keys/openpassword-backup.txt deploy/backup/restore-encrypted.sh backup.age ./restored
# The identity is an age private key file you own with mode 0600 (it may itself be passphrase-protected; age then asks).
# OPENPASSWORD_NODE names a Node 24 binary (default: node on PATH). Nothing is printed except status lines.
set -euo pipefail
umask 077
file=${1:-}; target=${2:-}
NODE=${OPENPASSWORD_NODE:-node}
IDENT=${OPENPASSWORD_BACKUP_IDENTITY:-}
[ -n "$file" ] && [ -n "$target" ] || { echo "restore-encrypted: usage: restore-encrypted.sh <file.age> <empty-target-dir>" >&2; exit 2; }
[ -n "$IDENT" ] || { echo "restore-encrypted: set OPENPASSWORD_BACKUP_IDENTITY to your age private key file" >&2; exit 2; }
command -v age >/dev/null || { echo "restore-encrypted: age is not installed" >&2; exit 1; }
command -v "$NODE" >/dev/null || { echo "restore-encrypted: no Node at $NODE (set OPENPASSWORD_NODE)" >&2; exit 1; }
[ -f "$file" ] || { echo "restore-encrypted: $file is not a file" >&2; exit 1; }
perm=$(stat -c %a "$IDENT" 2>/dev/null || stat -f %Lp "$IDENT" 2>/dev/null || true)
[ -f "$IDENT" ] && [ -O "$IDENT" ] && [ "$perm" = 600 ] \
  || { echo "restore-encrypted: $IDENT must be owned by you with mode 600" >&2; exit 1; }
[ -d "$target" ] && [ -z "$(ls -A "$target")" ] || { echo "restore-encrypted: $target must be an existing empty directory" >&2; exit 1; }
# Decrypt into a scratch directory beside the target, so a wrong key or a truncated file leaves the target empty.
work=$(mktemp -d "${target%/}.incoming.XXXXXXXX")
trap 'rm -rf -- "${work:?}"' EXIT
trap 'exit 1' HUP INT TERM
age -d -i "$IDENT" "$file" | tar -xf - -C "$work" \
  || { echo "restore-encrypted: could not decrypt $file with this key, or the file is damaged" >&2; exit 1; }
for f in vault.sqlite master.key; do
  [ -s "$work/$f" ] || { echo "restore-encrypted: the backup lacks $f" >&2; exit 1; }
done
"$NODE" --input-type=module -e '
import { DatabaseSync } from "node:sqlite"
const db = new DatabaseSync(process.argv[1] + "/vault.sqlite", { readOnly: true })
const r = db.prepare("PRAGMA integrity_check").get()
db.close()
if (!r || Object.values(r)[0] !== "ok") { console.error("restore-encrypted: vault integrity check failed"); process.exit(1) }
' "$work"
# Move only the files a backup holds; anything else in the archive is ignored.
for f in vault.sqlite master.key operator.token; do
  [ -e "$work/$f" ] && mv -- "$work/$f" "$target"/
done
echo "restore-encrypted: $file restored to $target and the vault passed its integrity check"
