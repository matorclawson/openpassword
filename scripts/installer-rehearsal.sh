#!/usr/bin/env bash
# Fresh-install rehearsal on a REAL systemd host. Run as root on a scratch host that has no OpenPassword
# install (production-04 style), from a checkout that holds deploy/install.sh:
#   sudo bash scripts/installer-rehearsal.sh ARCHIVE SHA256 COMMIT VERSION ARCH ORIGIN
# It refuses to run if /opt/openpassword, the units or the state directory already exist. It installs for
# real, checks the JSON contract and the same-version refusals, then removes everything it created.
# It never prints the setup code: it only checks that the file named in needs_human exists.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "rehearsal: run as root" >&2; exit 1; }
[ $# = 6 ] || { echo "usage: $0 ARCHIVE SHA256 COMMIT VERSION ARCH ORIGIN" >&2; exit 2; }
ARCHIVE=$1 SHA=$2 COMMIT=$3 VERSION=$4 ARCH=$5 ORIGIN=$6
cd "$(dirname "$0")/.."
for p in /opt/openpassword /etc/systemd/system/openpassword-broker.service /etc/systemd/system/openpassword-web.service /var/lib/openpassword; do
  [ ! -e "$p" ] || { echo "rehearsal: $p exists; this is not a scratch host" >&2; exit 1; }
done
out=$(mktemp); trap 'rm -f "$out"' EXIT
fail() { echo "rehearsal: FAIL: $*" >&2; exit 1; }
json() { node -p "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));$1" "$out"; }
run() { bash deploy/install.sh agent "$@" --archive "$ARCHIVE" --sha256 "$SHA" --commit "$COMMIT" --version "$VERSION" --arch "$ARCH" --origin "$ORIGIN" > "$out" || return $?; }
cleanup() {
  systemctl stop openpassword-web openpassword-broker 2>/dev/null || true
  systemctl disable openpassword-web openpassword-broker >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/openpassword-broker.service /etc/systemd/system/openpassword-web.service
  rm -rf /etc/systemd/system/openpassword-broker.service.d /opt/openpassword /var/lib/openpassword
  systemctl daemon-reload
}
trap 'rc=$?; cleanup; rm -f "$out"; exit $rc' EXIT

run plan || fail "plan"; [ "$(json r.state)" = ready ] || fail "plan state"
[ ! -e /opt/openpassword/current ] || fail "plan installed something"
rc=0; run apply || rc=$?
[ "$rc" = 10 ] && [ "$(json r.state)" = needs_human ] || fail "fresh apply: rc $rc $(json '(r.error||{}).code')"
systemctl is-active --quiet openpassword-broker && systemctl is-active --quiet openpassword-web || fail "units not active"
file=$(json 'r.needs_human.find(x=>x.step==="admin_account").where')
[ -s "$file" ] || fail "the setup-code file named in needs_human is missing"
run status || fail "status"
run apply || fail "same-version rerun"; [ "$(json r.state)" = ready ] || fail "rerun state"
rc=0; ORIGIN=https://other.example.com; run apply || rc=$?; [ "$rc" = 1 ] && [ "$(json '(r.error||{}).code')" = origin_differs ] || fail "other origin accepted: rc $rc"
echo "rehearsal: ok (cleaning up)"
