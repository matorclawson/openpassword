#!/usr/bin/env bash
# Runs INSIDE backup.sh --encrypt's transient systemd unit: snapshot into the unit's own runtime directory (a tmpfs that
# systemd removes when the unit stops), then tar and encrypt it. Only ciphertext goes to stdout.
#   unit-run.sh NODE SNAPSHOT.mjs DATA_DIR AGE_BINARY [-r RECIPIENT ...]
# It is a file, not an inline script, because systemd-run expands $VARIABLE and ${VARIABLE} in the arguments it is given.
set -euo pipefail
node=$1; snap=$2; data=$3; age=$4; shift 4
"$node" "$snap" "$data" "$RUNTIME_DIRECTORY" >/dev/null
cd "$RUNTIME_DIRECTORY"
files=(vault.sqlite master.key)
[ -f operator.token ] && files+=(operator.token)
tar -cf - "${files[@]}" | "$age" "$@"
