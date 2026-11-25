#!/usr/bin/env bash
# Open an age-encrypted backup made by `backup.sh --encrypt` and check it. Run this on YOUR machine, with your private key.
# It restores into an EMPTY directory and never touches a live data directory.
#   OPENPASSWORD_BACKUP_IDENTITY=~/keys/openpassword-backup.txt deploy/backup/restore-encrypted.sh backup.age ./restored
# The identity is an age private key file you own with mode 0600 (it may itself be passphrase-protected; age then asks).
# OPENPASSWORD_NODE names a Node 24 binary (default: node on PATH). Nothing is printed except status lines.
# The archive is decrypted to a scratch directory beside the target and examined before anything is extracted: it must hold
# exactly regular files named vault.sqlite, master.key and (optionally) operator.token, each once, and nothing else.
set -euo pipefail
umask 077
refuse() { echo "restore-encrypted: $*" >&2; exit 1; }
file=${1:-}; target=${2:-}
NODE=${OPENPASSWORD_NODE:-node}
IDENT=${OPENPASSWORD_BACKUP_IDENTITY:-}
[ -n "$file" ] && [ -n "$target" ] || { echo "restore-encrypted: usage: restore-encrypted.sh <file.age> <empty-target-dir>" >&2; exit 2; }
[ -n "$IDENT" ] || { echo "restore-encrypted: set OPENPASSWORD_BACKUP_IDENTITY to your age private key file" >&2; exit 2; }
command -v age >/dev/null || refuse "age is not installed"
command -v "$NODE" >/dev/null || refuse "no Node at $NODE (set OPENPASSWORD_NODE)"
[ -f "$file" ] || refuse "$file is not a file"
perm=$(stat -c %a "$IDENT" 2>/dev/null || stat -f %Lp "$IDENT" 2>/dev/null || true)
[ -f "$IDENT" ] && [ -O "$IDENT" ] && [ "$perm" = 600 ] || refuse "$IDENT must be owned by you with mode 600"
[ -d "$target" ] && [ -z "$(ls -A "$target")" ] || refuse "$target must be an existing empty directory"
work=$(mktemp -d "${target%/}.incoming.XXXXXXXX")
trap 'rm -rf -- "${work:?}"' EXIT
trap 'exit 1' HUP INT TERM
mkdir -m 0700 "$work/out"
# 1. Decrypt completely. A wrong key or a truncated file fails here, before anything is looked at.
age -d -i "$IDENT" -o "$work/state.tar" "$file" || refuse "could not decrypt $file with this key, or the file is damaged"
# 2. Examine the members without extracting: names exactly the allowlist, each once, every one a regular file.
names=$(tar -tf "$work/state.tar") || refuse "the decrypted backup is not a readable archive"
long=$(tar -tvf "$work/state.tar") || refuse "the decrypted backup is not a readable archive"
count=0; seen=
while IFS= read -r name; do
  case "$name" in
    vault.sqlite|master.key|operator.token) ;;
    *) refuse "unexpected member in the backup: $name" ;;
  esac
  case " $seen " in *" $name "*) refuse "duplicate member in the backup: $name" ;; esac
  seen="$seen $name"; count=$((count + 1))
done <<< "$names"
[ "$count" -gt 0 ] || refuse "the backup is empty"
types=0
while IFS= read -r row; do
  [ "${row:0:1}" = "-" ] || refuse "the backup holds a member that is not a regular file"
  types=$((types + 1))
done <<< "$long"
[ "$types" = "$count" ] || refuse "the backup listing is inconsistent"
case " $seen " in *" vault.sqlite "*) ;; *) refuse "the backup lacks vault.sqlite" ;; esac
case " $seen " in *" master.key "*) ;; *) refuse "the backup lacks master.key" ;; esac
# 3. Extract into a scratch directory and check what landed there.
tar -xf "$work/state.tar" -C "$work/out" --no-same-owner --no-same-permissions
rm -f -- "$work/state.tar"
for f in vault.sqlite master.key; do
  [ -f "$work/out/$f" ] && [ ! -L "$work/out/$f" ] && [ -s "$work/out/$f" ] || refuse "the backup lacks a usable $f"
done
if [ -e "$work/out/operator.token" ]; then
  [ -f "$work/out/operator.token" ] && [ ! -L "$work/out/operator.token" ] || refuse "operator.token is not a regular file"
fi
[ "$(find "$work/out" -mindepth 1 | wc -l | tr -d ' ')" = "$count" ] || refuse "the extracted backup holds unexpected entries"
"$NODE" --input-type=module -e '
import { DatabaseSync } from "node:sqlite"
const db = new DatabaseSync(process.argv[1] + "/vault.sqlite", { readOnly: true })
const r = db.prepare("PRAGMA integrity_check").get()
db.close()
if (!r || Object.values(r)[0] !== "ok") { console.error("restore-encrypted: vault integrity check failed"); process.exit(1) }
' "$work/out"
# 4. Publish only now.
for f in vault.sqlite master.key operator.token; do
  if [ -e "$work/out/$f" ]; then mv -- "$work/out/$f" "$target"/; fi
done
echo "restore-encrypted: $file restored to $target and the vault passed its integrity check"
