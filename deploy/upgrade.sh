#!/bin/sh
# Linux entry point. The gate supplies this script and an independent digest record.
set -eu
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset NODE_OPTIONS NODE_PATH TAR_OPTIONS
die() { echo "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "Run as root."
root=/opt/openpassword
install -d -m 0755 "$root" "$root/releases"
install -d -m 0700 "$root/upgrade-state"
exec 9>"$root/upgrade-state/lock"
flock -n 9 || die "An activation is already running."
case "${1:-}" in
  --recover|--rollback)
    [ "$#" = 2 ] || die "Usage: upgrade.sh --rollback|--recover VERSION-WITH-UPGRADER"
    case "$2" in *[!0-9.]*) die "Invalid installed version" ;; esac
    printf '%s\n' "$2" | grep -Exq '[0-9]+\.[0-9]+\.[0-9]+' || die "Invalid installed version"
    runtime="$root/releases/$2"
    exec "$runtime/node/bin/node" "$runtime/deploy/upgrade.ts" "$1"
    ;;
  --install)
    [ "$#" = 5 ] || die "Usage: upgrade.sh --install ARCHIVE SHA256 VERSION COMMIT"
    ;;
  *) die "Use --install, --recover or --rollback" ;;
esac
archive=$2
digest=$3
version=$4
commit=$5
case "$digest$version$commit" in *'
'*) die "Invalid gate record" ;; esac
printf '%s\n' "$digest" | grep -Exq '[a-f0-9]{64}' || die "Invalid gate SHA-256"
printf '%s\n' "$version" | grep -Exq '[0-9]+\.[0-9]+\.[0-9]+' || die "Invalid version"
printf '%s\n' "$commit" | grep -Exq '[a-f0-9]{40}' || die "Invalid commit"
stage=$(mktemp -d "$root/.install.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
trap 'exit 1' HUP INT TERM
cp -- "$archive" "$stage/archive"
actual=$(sha256sum "$stage/archive")
[ "${actual%% *}" = "$digest" ] || die "Gate digest mismatch"
mkdir "$stage/tree"
tar --extract --gzip --file="$stage/archive" --directory="$stage/tree" --no-same-owner --same-permissions
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "Unsupported architecture" ;; esac
# A foreign executable fails before installation or activation.
[ -x "$stage/tree/node/bin/node" ] || die "Missing bundled Node"
"$stage/tree/node/bin/node" "$stage/tree/deploy/upgrade.ts" --install "$stage/tree" "$digest" "$version" "$commit" "$arch"
