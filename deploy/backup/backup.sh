#!/usr/bin/env bash
# Encrypted off-host backup of the OpenPassword data directory with borg (client-side encryption).
#   deploy/backup/backup.sh            run as root: snapshot under the broker's service identity, then borg
#   deploy/backup/backup.sh --direct   run as the user that owns the data directory (tests, local installs)
#   deploy/backup/backup.sh --stream [--direct]
#                                       write the snapshot to stdout as a tar and nothing else: no borg, no env file,
#                                       no backup key on this host (used by deploy/backup/pull.sh, run by the operator)
# The settings come from an env file that must be owned by the invoking user with mode 0600:
#   BORG_REPO, BORG_PASSCOMMAND (a command that prints the passphrase; never the passphrase itself),
#   optional BORG_RSH. Values are never printed. master.key travels inside the encrypted archive.
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
DATA=${OPENPASSWORD_HOME:-/var/lib/openpassword}
NODE=${OPENPASSWORD_NODE:-/opt/openpassword/current/node/bin/node}
ENVF=${OPENPASSWORD_BACKUP_ENV:-/etc/openpassword/backup.env}
mode=systemd; stream=0
case "${1:-}" in
  "") ;;
  --direct) mode=--direct ;;
  --stream) stream=1; case "${2:-}" in "") ;; --direct) mode=--direct ;; *) echo "backup: usage: backup.sh [--direct | --stream [--direct]]" >&2; exit 2 ;; esac ;;
  *) echo "backup: usage: backup.sh [--direct | --stream [--direct]]" >&2; exit 2 ;;
esac
[ -x "$NODE" ] || { echo "backup: no executable Node at $NODE (set OPENPASSWORD_NODE)" >&2; exit 1; }
if [ "$stream" = 0 ]; then
  command -v borg >/dev/null || { echo "backup: borg is not installed" >&2; exit 1; }
  [ -f "$ENVF" ] && [ "$(stat -c '%u %a' "$ENVF")" = "$(id -u) 600" ] \
    || { echo "backup: $ENVF must be owned by this user with mode 600" >&2; exit 1; }
  set -a; . "$ENVF"; set +a
  [ -n "${BORG_REPO:-}" ] && [ -n "${BORG_PASSCOMMAND:-}" ] && [ -z "${BORG_PASSPHRASE:-}" ] \
    || { echo "backup: the env file must set BORG_REPO and BORG_PASSCOMMAND, and must not set BORG_PASSPHRASE" >&2; exit 1; }
fi

# The snapshot holds the vault and the master key in plain form. As root, stage it on /run (a tmpfs, never the disk).
if [ "$(id -u)" = 0 ] && [ -d /run ] && [ -w /run ]; then stage=$(mktemp -d /run/openpassword-backup.XXXXXXXX); else stage=$(mktemp -d); fi
trap 'rm -rf "$stage"' EXIT
if [ "$mode" = --direct ]; then
  [ "$(stat -c '%u' "$DATA")" = "$(id -u)" ] \
    || { echo "backup: $DATA is not owned by this user; run without --direct as root" >&2; exit 1; }
  "$NODE" "$here/snapshot.mjs" "$DATA" "$stage" >/dev/null
else
  [ "$(id -u)" = 0 ] || { echo "backup: run as root, or use --direct" >&2; exit 1; }
  # The snapshot runs as the broker's own dynamic identity, so it cannot change file ownership in the state directory.
  run=openpassword-backup-$$
  systemd-run --quiet --pipe --wait --collect -u "$run" \
    -p User=openpassword-broker -p DynamicUser=yes -p StateDirectory=openpassword \
    -p RuntimeDirectory="$run" -p RuntimeDirectoryMode=0700 -p RuntimeDirectoryPreserve=yes \
    -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p NoNewPrivileges=yes \
    "$NODE" "$here/snapshot.mjs" "$DATA" "/run/$run" >/dev/null
  cp -a "/run/$run/." "$stage/"
  rm -rf "/run/$run"
fi
if [ "$stream" = 1 ]; then
  # Only the tar goes to stdout. Whoever reads it must encrypt it before it is stored anywhere.
  tar -C "$stage" -cf - vault.sqlite master.key $([ -f "$stage/operator.token" ] && echo operator.token)
  exit 0
fi
name=openpassword-$(date -u +%Y%m%dT%H%M%SZ)
( cd "$stage" && borg create --stats --compression zstd "::$name" . >/dev/null )
echo "backup: archive $name written"
