#!/usr/bin/env bash
# Off-host backup of the OpenPassword data directory.
#   deploy/backup/backup.sh            run as root: snapshot under the broker's service identity, then borg
#   deploy/backup/backup.sh --direct   run as the user that owns the data directory (tests, local installs)
#   deploy/backup/backup.sh --encrypt [--direct]
#       write the snapshot to STDOUT as age ciphertext for the public key(s) in OPENPASSWORD_BACKUP_RECIPIENT
#       (default /etc/openpassword/backup.recipient). No borg, no passphrase, no private key and no storage key on this
#       host: it can encrypt but never decrypt. The operator holds the private key. A non-zero exit means the output is
#       not a backup: write to a file and delete it on failure.
#       As root the plaintext exists only inside the snapshot unit's runtime directory (a tmpfs that systemd removes when the
#       unit stops); with --direct it exists only in a directory on a tmpfs or ramfs. Both refuse when swap could
#       write that memory to an unencrypted disk. Cancelling stops and waits for the unit before the script exits.
# The borg mode takes its settings from an env file that must be owned by the invoking user with mode 0600:
#   BORG_REPO, BORG_PASSCOMMAND (a command that prints the passphrase; never the passphrase itself),
#   optional BORG_RSH. Values are never printed. master.key travels inside the encrypted archive.
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
DATA=${OPENPASSWORD_HOME:-/var/lib/openpassword}
NODE=${OPENPASSWORD_NODE:-/opt/openpassword/current/node/bin/node}
ENVF=${OPENPASSWORD_BACKUP_ENV:-/etc/openpassword/backup.env}
RECIP=${OPENPASSWORD_BACKUP_RECIPIENT:-/etc/openpassword/backup.recipient}
refuse() { echo "backup: $*" >&2; exit 1; }
usage() { echo "backup: usage: backup.sh [--direct | --encrypt [--direct]]" >&2; exit 2; }
mode=systemd; encrypt=0
case "${1:-}" in
  "") ;;
  --direct) mode=--direct ;;
  --encrypt) encrypt=1; case "${2:-}" in "") ;; --direct) mode=--direct ;; *) usage ;; esac ;;
  *) usage ;;
esac
[ -x "$NODE" ] || refuse "no executable Node at $NODE (set OPENPASSWORD_NODE)"

. "$here/stage-check.sh"
# Read the recipient file once, refuse on any read or validation error, and keep the validated keys for age.
RECIPS=()
read_recipients() {
  local f=$1 own perm content line
  [ -f "$f" ] && [ ! -L "$f" ] || refuse "no regular recipient file at $f"
  own=$(stat -c %u -- "$f") && perm=$(stat -c %a -- "$f") || refuse "cannot inspect $f"
  [ "$own" = "$(id -u)" ] || refuse "$f must be owned by the user running the backup"
  (( (8#$perm & 8#022) == 0 )) || refuse "$f must not be writable by group or others"
  content=$(cat -- "$f") || refuse "cannot read $f"
  while IFS= read -r line || [ -n "$line" ]; do
    # Private key material anywhere in the file, even in a comment, refuses the whole file.
    case "$line" in *AGE-SECRET-KEY*|*AGE-PLUGIN-*|*'PRIVATE KEY'*) refuse "$f holds private key material; it must contain public keys only" ;; esac
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" =~ ^age1[0-9a-z]{50,}$ ]] || refuse "$f must contain only age1 public keys and comments (never a private key)"
    RECIPS+=(-r "$line")
  done <<< "$content"
  [ "${#RECIPS[@]}" -gt 0 ] || refuse "$f holds no age public key"
}

AGE=
if [ "$encrypt" = 1 ]; then
  AGE=${OPENPASSWORD_BACKUP_AGE:-$(command -v age || true)}
  case "$AGE" in /*) [ -x "$AGE" ] || AGE= ;; *) AGE= ;; esac
  [ -n "$AGE" ] || refuse "age is not installed (or OPENPASSWORD_BACKUP_AGE is not an absolute executable path)"
  if [ -t 1 ]; then refuse "refusing to write ciphertext to a terminal; redirect stdout to a file"; fi
  # Everything that can be refused is refused here, before any snapshot exists.
  read_recipients "$RECIP"
  if [ "$mode" = --direct ]; then
    base=${OPENPASSWORD_BACKUP_STAGE:-${XDG_RUNTIME_DIR:-/dev/shm}}
    [ -d "$base" ] && [ -w "$base" ] || refuse "no writable memory-backed directory at $base"
    memory_only "$base" || refuse "$base is not memory-only (tmpfs or ramfs with no unencrypted swap); refusing to stage the plain snapshot"
  else
    [ "$(id -u)" = 0 ] || refuse "run as root, or use --direct"
    memory_only /run || refuse "/run is not memory-only (tmpfs with no unencrypted swap); refusing to stage the plain snapshot"
  fi
else
  command -v borg >/dev/null || refuse "borg is not installed"
  [ -f "$ENVF" ] && [ "$(stat -c '%u %a' "$ENVF")" = "$(id -u) 600" ] \
    || refuse "$ENVF must be owned by this user with mode 600"
  set -a; . "$ENVF"; set +a
  [ -n "${BORG_REPO:-}" ] && [ -n "${BORG_PASSCOMMAND:-}" ] && [ -z "${BORG_PASSPHRASE:-}" ] \
    || refuse "the env file must set BORG_REPO and BORG_PASSCOMMAND, and must not set BORG_PASSPHRASE"
fi

stage=; unit=; child=; runtmp=
cleanup() {
  trap - EXIT HUP INT TERM
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi
  # Stop the snapshot unit and wait: only then is its writer gone and its runtime directory removed by systemd.
  if [ -n "$unit" ]; then systemctl stop "$unit" >/dev/null 2>&1 || true; fi
  if [ -n "$runtmp" ]; then rm -rf -- "${runtmp:?}"; fi
  if [ -n "$stage" ]; then rm -rf -- "${stage:?}"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if [ "$encrypt" = 1 ] && [ "$mode" != --direct ]; then
  # The unit takes the snapshot into its own runtime directory (tmpfs, removed when it stops) and encrypts it there:
  # the plaintext never reaches this shell, a pipe to it, or a disk. Only ciphertext comes back on stdout.
  run=openpassword-backup-$$
  unit=$run.service
  inner='set -euo pipefail
node=$1; snap=$2; data=$3; age=$4; shift 4
"$node" "$snap" "$data" "$RUNTIME_DIRECTORY" >/dev/null
cd "$RUNTIME_DIRECTORY"
files=(vault.sqlite master.key)
[ -f operator.token ] && files+=(operator.token)
tar -cf - "${files[@]}" | "$age" "$@"'
  systemd-run --quiet --pipe --wait --collect -u "$run" \
    -p User=openpassword-broker -p DynamicUser=yes -p StateDirectory=openpassword \
    -p RuntimeDirectory="$run" -p RuntimeDirectoryMode=0700 \
    -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p PrivateNetwork=yes -p NoNewPrivileges=yes \
    /bin/bash -c "$inner" bash "$NODE" "$here/snapshot.mjs" "$DATA" "$AGE" "${RECIPS[@]}" </dev/null &
  child=$!
  wait "$child"
  child=
  exit 0
fi

if [ "$encrypt" = 1 ]; then
  stage=$(mktemp -d "$base/openpassword-backup.XXXXXXXX")
else
  # Borg mode: as root the plain snapshot is staged on /run (tmpfs), otherwise on the temporary directory.
  if [ "$(id -u)" = 0 ] && [ -d /run ] && [ -w /run ]; then base=/run; else base=${TMPDIR:-/tmp}; fi
  stage=$(mktemp -d "$base/openpassword-backup.XXXXXXXX")
fi
if [ "$mode" = --direct ]; then
  [ "$(stat -c '%u' "$DATA")" = "$(id -u)" ] \
    || refuse "$DATA is not owned by this user; run without --direct as root"
  "$NODE" "$here/snapshot.mjs" "$DATA" "$stage" >/dev/null
else
  [ "$(id -u)" = 0 ] || refuse "run as root, or use --direct"
  # The snapshot runs as the broker's own dynamic identity, so it cannot change file ownership in the state directory.
  run=openpassword-backup-$$
  unit=$run.service
  runtmp=/run/$run
  systemd-run --quiet --pipe --wait --collect -u "$run" \
    -p User=openpassword-broker -p DynamicUser=yes -p StateDirectory=openpassword \
    -p RuntimeDirectory="$run" -p RuntimeDirectoryMode=0700 -p RuntimeDirectoryPreserve=yes \
    -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p NoNewPrivileges=yes \
    "$NODE" "$here/snapshot.mjs" "$DATA" "/run/$run" >/dev/null </dev/null &
  child=$!
  wait "$child"
  child=
  cp -a "/run/$run/." "$stage/"
fi
if [ "$encrypt" = 1 ]; then
  files=(vault.sqlite master.key)
  [ -f "$stage/operator.token" ] && files+=(operator.token)
  # stdout is the ciphertext and nothing else; a failure anywhere in the pipe fails the script.
  tar -C "$stage" -cf - "${files[@]}" | "$AGE" "${RECIPS[@]}"
  exit 0
fi
name=openpassword-$(date -u +%Y%m%dT%H%M%SZ)
( cd "$stage" && borg create --stats --compression zstd "::$name" . >/dev/null )
echo "backup: archive $name written"
