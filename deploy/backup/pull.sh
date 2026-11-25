#!/usr/bin/env bash
# Operator-run off-host backup. Run this on YOUR machine, not on the OpenPassword host.
# The host takes the consistent snapshot under the service identity and streams it out over ssh as a tar;
# borg encrypts it here, so the borg key, passphrase and repository never exist on the host.
#   OPENPASSWORD_BACKUP_HOST=operator@pass.example.com deploy/backup/pull.sh
# Settings come from an env file that you own with mode 0600 (default ~/.config/openpassword/backup.env):
#   BORG_REPO, BORG_PASSCOMMAND (a command that prints the passphrase, never the passphrase itself), optional BORG_RSH.
# Optional: OPENPASSWORD_BACKUP_SSH (ssh command, default ssh), OPENPASSWORD_BACKUP_REMOTE (the host command).
# Values are never printed. The archive holds one file, state.tar, with vault.sqlite, master.key and operator.token.
set -euo pipefail
umask 077
ENVF=${OPENPASSWORD_BACKUP_ENV:-$HOME/.config/openpassword/backup.env}
HOST=${OPENPASSWORD_BACKUP_HOST:-}
SSH=${OPENPASSWORD_BACKUP_SSH:-ssh}
REMOTE=${OPENPASSWORD_BACKUP_REMOTE:-sudo -n /opt/openpassword/current/deploy/backup/backup.sh --stream}
[ -n "$HOST" ] || { echo "pull: set OPENPASSWORD_BACKUP_HOST to the ssh target of the OpenPassword host" >&2; exit 2; }
command -v borg >/dev/null || { echo "pull: borg is not installed on this machine" >&2; exit 1; }
perm=$(stat -c %a "$ENVF" 2>/dev/null || stat -f %Lp "$ENVF" 2>/dev/null || true)
[ -f "$ENVF" ] && [ -O "$ENVF" ] && [ "$perm" = 600 ] \
  || { echo "pull: $ENVF must be owned by you with mode 600" >&2; exit 1; }
set -a; . "$ENVF"; set +a
[ -n "${BORG_REPO:-}" ] && [ -n "${BORG_PASSCOMMAND:-}" ] && [ -z "${BORG_PASSPHRASE:-}" ] \
  || { echo "pull: the env file must set BORG_REPO and BORG_PASSCOMMAND, and must not set BORG_PASSPHRASE" >&2; exit 1; }

name=openpassword-$(date -u +%Y%m%dT%H%M%SZ)
set +e
# shellcheck disable=SC2086
$SSH "$HOST" $REMOTE | borg create --stdin-name state.tar --compression zstd "::$name" - >/dev/null
rc=("${PIPESTATUS[@]}")
set -e
if [ "${rc[0]}" != 0 ] || [ "${rc[1]}" != 0 ]; then
  # A broken stream can leave a truncated archive. Remove it so it can never be taken for a good one.
  borg delete "::$name" >/dev/null 2>&1 || echo "pull: could not remove the failed archive $name; delete it by hand" >&2
  echo "pull: FAILED (host command exit ${rc[0]}, borg exit ${rc[1]}); no archive was kept" >&2
  exit 1
fi
# Read it back: the tar must be whole and hold the vault and the master key.
listing=$(borg extract --stdout "::$name" state.tar | tar -tf -) \
  || { echo "pull: the archive $name could not be read back" >&2; exit 1; }
for f in vault.sqlite master.key; do
  printf '%s\n' "$listing" | grep -qx "$f" || { echo "pull: archive $name lacks $f" >&2; exit 1; }
done
echo "pull: archive $name written and read back"
