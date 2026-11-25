#!/usr/bin/env bash
# Encrypted off-host backup of the OpenPassword data directory with borg (client-side encryption).
#   deploy/backup/backup.sh            run as root: snapshot under the broker's service identity, then borg
#   deploy/backup/backup.sh --direct   run as the user that owns the data directory (tests, local installs)
#   deploy/backup/backup.sh --encrypt [--direct]
#                                       write the snapshot to STDOUT as age ciphertext for the public key(s) in
#                                       OPENPASSWORD_BACKUP_RECIPIENT (default /etc/openpassword/backup.recipient).
#                                       No borg, no passphrase, no private key and no storage key on this host: it can
#                                       encrypt but never decrypt. The operator holds the private key.
# The settings come from an env file that must be owned by the invoking user with mode 0600:
#   BORG_REPO, BORG_PASSCOMMAND (a command that prints the passphrase; never the passphrase itself),
#   optional BORG_RSH. Values are never printed. master.key travels inside the encrypted archive.
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
DATA=${OPENPASSWORD_HOME:-/var/lib/openpassword}
NODE=${OPENPASSWORD_NODE:-/opt/openpassword/current/node/bin/node}
ENVF=${OPENPASSWORD_BACKUP_ENV:-/etc/openpassword/backup.env}
RECIP=${OPENPASSWORD_BACKUP_RECIPIENT:-/etc/openpassword/backup.recipient}
usage() { echo "backup: usage: backup.sh [--direct | --encrypt [--direct]]" >&2; exit 2; }
mode=systemd; encrypt=0
case "${1:-}" in
  "") ;;
  --direct) mode=--direct ;;
  --encrypt) encrypt=1; case "${2:-}" in "") ;; --direct) mode=--direct ;; *) usage ;; esac ;;
  *) usage ;;
esac
[ -x "$NODE" ] || { echo "backup: no executable Node at $NODE (set OPENPASSWORD_NODE)" >&2; exit 1; }
if [ "$encrypt" = 1 ]; then
  command -v age >/dev/null || { echo "backup: age is not installed" >&2; exit 1; }
  [ -t 1 ] && { echo "backup: refusing to write ciphertext to a terminal; redirect stdout to a file" >&2; exit 1; }
  # Fail closed before any snapshot exists: the recipient file must hold only age public keys.
  [ -f "$RECIP" ] || { echo "backup: no recipient file at $RECIP" >&2; exit 1; }
  grep -qE '^age1[0-9a-z]{50,}$' "$RECIP" || { echo "backup: $RECIP holds no age public key" >&2; exit 1; }
  if grep -vE '^(age1[0-9a-z]{50,}|#.*|[[:space:]]*)$' "$RECIP" | grep -q .; then
    echo "backup: $RECIP must contain only age1 public keys and comments (never a private key)" >&2; exit 1
  fi
else
  command -v borg >/dev/null || { echo "backup: borg is not installed" >&2; exit 1; }
  [ -f "$ENVF" ] && [ "$(stat -c '%u %a' "$ENVF")" = "$(id -u) 600" ] \
    || { echo "backup: $ENVF must be owned by this user with mode 600" >&2; exit 1; }
  set -a; . "$ENVF"; set +a
  [ -n "${BORG_REPO:-}" ] && [ -n "${BORG_PASSCOMMAND:-}" ] && [ -z "${BORG_PASSPHRASE:-}" ] \
    || { echo "backup: the env file must set BORG_REPO and BORG_PASSCOMMAND, and must not set BORG_PASSPHRASE" >&2; exit 1; }
fi

# The snapshot holds the vault and the master key in plain form while it exists. As root it is staged on /run (a tmpfs),
# never on the disk, and it is removed on every exit path, including failure and termination.
base=${OPENPASSWORD_BACKUP_STAGE:-}
if [ -z "$base" ]; then
  if [ "$(id -u)" = 0 ] && [ -d /run ] && [ -w /run ]; then base=/run; else base=${TMPDIR:-/tmp}; fi
fi
stage=$(mktemp -d "$base/openpassword-backup.XXXXXXXX")
runtmp=
trap 'rm -rf -- "${stage:?}" ${runtmp:+"$runtmp"}' EXIT
trap 'exit 1' HUP INT TERM
if [ "$mode" = --direct ]; then
  [ "$(stat -c '%u' "$DATA")" = "$(id -u)" ] \
    || { echo "backup: $DATA is not owned by this user; run without --direct as root" >&2; exit 1; }
  "$NODE" "$here/snapshot.mjs" "$DATA" "$stage" >/dev/null
else
  [ "$(id -u)" = 0 ] || { echo "backup: run as root, or use --direct" >&2; exit 1; }
  # The snapshot runs as the broker's own dynamic identity, so it cannot change file ownership in the state directory.
  run=openpassword-backup-$$
  runtmp=/run/$run
  systemd-run --quiet --pipe --wait --collect -u "$run" \
    -p User=openpassword-broker -p DynamicUser=yes -p StateDirectory=openpassword \
    -p RuntimeDirectory="$run" -p RuntimeDirectoryMode=0700 -p RuntimeDirectoryPreserve=yes \
    -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p NoNewPrivileges=yes \
    "$NODE" "$here/snapshot.mjs" "$DATA" "/run/$run" >/dev/null
  cp -a "/run/$run/." "$stage/"
  rm -rf "/run/$run"
fi
if [ "$encrypt" = 1 ]; then
  files=(vault.sqlite master.key)
  [ -f "$stage/operator.token" ] && files+=(operator.token)
  # stdout is the ciphertext and nothing else; a failure anywhere in the pipe fails the script.
  tar -C "$stage" -cf - "${files[@]}" | age -R "$RECIP"
  exit 0
fi
name=openpassword-$(date -u +%Y%m%dT%H%M%SZ)
( cd "$stage" && borg create --stats --compression zstd "::$name" . >/dev/null )
echo "backup: archive $name written"
