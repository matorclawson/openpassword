#!/usr/bin/env bash
# Tests the production (root, systemd) path of `backup.sh --encrypt`: the snapshot and the encryption run inside one
# transient unit whose runtime directory is a tmpfs; cancelling stops and joins that unit.
# Run as root on a STAGING host that has the broker's state directory (a disposable vault), systemd, age, tar and Node.
# It only reads the vault (a snapshot); it writes nothing under the state directory. Fails, not skips, when unmet.
#   OPENPASSWORD_HOME=/var/lib/openpassword OPENPASSWORD_NODE=/opt/openpassword/current/node/bin/node \
#     OPENPASSWORD_BACKUP_RECIPIENT=<root-owned file with a throwaway age public key> bash scripts/backup-age-systemd-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "backup-age-systemd-test: FAIL: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "run as root"
[ -d /run/systemd/system ] && command -v systemd-run >/dev/null || fail "systemd is required"
command -v age >/dev/null && command -v age-keygen >/dev/null || fail "age and age-keygen are required"
export OPENPASSWORD_HOME=${OPENPASSWORD_HOME:-/var/lib/openpassword}
export OPENPASSWORD_NODE=${OPENPASSWORD_NODE:-/opt/openpassword/current/node/bin/node}
[ -x "$OPENPASSWORD_NODE" ] || fail "no Node at $OPENPASSWORD_NODE"
t=$(mktemp -d /root/op-backup-systemd.XXXXXXXX); chmod 700 "$t"
shim=$(mktemp -d /run/op-backup-shim.XXXXXXXX); chmod 755 "$shim"
trap 'rm -rf -- "${t:?}" "${shim:?}"' EXIT
age-keygen -o "$t/id.txt" >/dev/null 2>&1; chmod 600 "$t/id.txt"
age-keygen -y "$t/id.txt" > "$t/recipient"; chmod 644 "$t/recipient"
export OPENPASSWORD_BACKUP_RECIPIENT=$t/recipient
units() { systemctl list-units --all --no-legend --plain 'openpassword-backup-*' | awk '{print $1}'; }
[ -z "$(units)" ] || fail "an openpassword-backup unit already exists"

# 1. A normal run: ciphertext on stdout, a restorable vault, no unit and no runtime directory left.
bash deploy/backup/backup.sh --encrypt > "$t/out.age" || fail "encrypted backup as root"
[ -s "$t/out.age" ] || fail "no ciphertext"
if grep -qa 'SQLite format' "$t/out.age"; then fail "plain text in the ciphertext"; fi
[ -z "$(units)" ] || fail "a unit was left after success"
[ -z "$(ls -d /run/openpassword-backup-* 2>/dev/null)" ] || fail "a runtime directory was left after success"
mkdir -m 0700 "$t/restored"
OPENPASSWORD_BACKUP_IDENTITY=$t/id.txt OPENPASSWORD_NODE=$OPENPASSWORD_NODE bash deploy/backup/restore-encrypted.sh "$t/out.age" "$t/restored" >/dev/null || fail "restore"

# 2. Cancellation during the snapshot phase: a slow Node stands in for a slow snapshot.
cat > "$shim/slow-node" <<SH
#!/bin/sh
sleep 40
exec "$OPENPASSWORD_NODE" "\$@"
SH
chmod 755 "$shim/slow-node"
interrupt() { # phase name, then env assignments
  local phase=$1; shift
  env "$@" bash deploy/backup/backup.sh --encrypt > "$t/$phase.out" 2>/dev/null &
  local pid=$!
  for _ in $(seq 1 100); do [ -n "$(units)" ] && break; sleep 0.1; done
  [ -n "$(units)" ] || fail "the $phase unit never started"
  local unit; unit=$(units | head -1)
  [ -d "/run/${unit%.service}" ] || fail "the $phase runtime directory was not created"
  kill -TERM "$pid"
  wait "$pid" 2>/dev/null || true
  # The script must not return before the unit is stopped and its runtime directory is gone.
  [ -z "$(units)" ] || fail "the unit was still present after the $phase cancellation returned"
  [ ! -e "/run/${unit%.service}" ] || fail "the runtime directory was left after the $phase cancellation"
  [ ! -s "$t/$phase.out" ] || fail "the $phase cancellation wrote output"
}
interrupt snapshot OPENPASSWORD_NODE="$shim/slow-node"
# Cancellation during the encryption phase.
printf '#!/bin/sh\nsleep 40\n' > "$shim/slow-age"; chmod 755 "$shim/slow-age"
interrupt encryption OPENPASSWORD_BACKUP_AGE="$shim/slow-age"
echo "backup-age-systemd-test: ok"
