#!/usr/bin/env bash
# Tests deploy/install.sh against a fake host: a temporary prefix, stub systemctl/systemd-run/curl/install/cp/ln,
# a fake /proc and fake release archives. It proves the JSON contract, idempotence, refusals, the transactional
# switch (write failures, a failed baseline capture, failed activation, rollback and failed rollback), that the
# serving process is verified, serialization, and that no secret is printed. It does not prove real systemd
# behaviour (see scripts/installer-rehearsal.sh). Linux only; needs Node (any version) and flock.
set -euo pipefail
cd "$(dirname "$0")/.."
real_node=$(command -v node)
t=$(mktemp -d); trap 'rm -rf "${t:?}"' EXIT
mkdir -p "$t/bin" "$t/units" "$t/state" "$t/pids" "$t/proc"
fail() { echo "installer-test: FAIL: $*" >&2; exit 1; }

# Stubs. systemctl models main PIDs: start gives a service a new PID whose cwd is the current release.
cat > "$t/bin/systemctl" <<'S'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1" in
  is-active) [ "${STUB_INACTIVE:-}" != 1 ] ;;
  daemon-reload) [ "${STUB_RELOAD_FAIL:-}" != 1 ] ;;
  stop) [ "${STUB_STOP_FAIL:-}" != 1 ] || exit 1
        [ "${STUB_STALE:-}" = 1 ] || for s in "${@:2}"; do rm -f "${STUB_PIDS:?}/${s:?}"; done ;;
  start) [ "${STUB_STALE:-}" = 1 ] && exit 0
         n=$(( $(cat "$STUB_PIDS/.n" 2>/dev/null || echo 100) + 1 )); echo "$n" > "$STUB_PIDS/.n"; echo "$n" > "$STUB_PIDS/$2"
         mkdir -p "$STUB_PROC/$n"
         if [ "${STUB_WRONGCWD:-}" = 1 ]; then ln -sfn / "$STUB_PROC/$n/cwd"; else ln -sfn "$(readlink -f "$OPENPASSWORD_PREFIX/current")" "$STUB_PROC/$n/cwd"; fi ;;
  show) cat "$STUB_PIDS/${*: -1}" 2>/dev/null || echo 0 ;;
  *) exit 0 ;;
esac
S
cat > "$t/bin/systemd-run" <<'S'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -p) shift 2 ;; --property=WorkingDirectory=*) cd "${1#*=}"; shift ;; --*) shift ;; *) break ;; esac; done
exec "$@"
S
cat > "$t/bin/curl" <<'S'
#!/usr/bin/env bash
[ "${STUB_UNHEALTHY:-}" != 1 ] || exit 1
[ -z "${STUB_UNHEALTHY_AT:-}" ] || [[ "$(readlink "$OPENPASSWORD_PREFIX/current")" != *"$STUB_UNHEALTHY_AT" ]]
S
# install, cp and ln with a failure injected at the Nth call (counted in a file the test resets).
for tool in install cp ln; do
  up=$(echo "$tool" | tr a-z A-Z)
  cat > "$t/bin/$tool" <<S
#!/usr/bin/env bash
c=\$STUB_DIR/count-$tool
n=\$(( \$(cat "\$c" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "\$c"
[ "\$n" = "\${STUB_${up}_FAIL:-0}" ] && exit 1
exec $(command -v "$tool") "\$@"
S
done
chmod +x "$t/bin/"*
export STUB_LOG=$t/log STUB_PIDS=$t/pids STUB_PROC=$t/proc STUB_DIR=$t
resetcount() { rm -f "${t:?}"/count-*; }
drop_baselines() { rm -rf "${t:?}"/prefix/.snap-*; }

pin=$("$real_node" -p process.version)
host_arch() { case "$(uname -m)" in aarch64|arm64) echo arm64 ;; x86_64) echo x64 ;; *) uname -m ;; esac; }
arch=$(host_arch)
commit=0123456789abcdef0123456789abcdef01234567
mkrel() { # build a fake release with the given version
  local v=$1 d=$t/rel-$1
  mkdir -p "$d/server" "$d/node_modules/next/dist/bin" "$d/node_modules/tsx" "$d/packages/cli/dist" "$d/.next" "$d/node/bin" "$d/deploy/systemd"
  : > "$d/server/main.ts"; : > "$d/packages/cli/dist/index.js"; echo build > "$d/.next/BUILD_ID"; echo '{}' > "$d/node_modules/tsx/package.json"
  echo 'console.log("fake next")' > "$d/node_modules/next/dist/bin/next"
  printf '#!/usr/bin/env bash\nargs=()\nwhile [ $# -gt 0 ]; do if [ "$1" = --import ]; then shift 2; else args+=("$1"); shift; fi; done\nexec "%s" "${args[@]}"\n' "$real_node" > "$d/node/bin/node"; chmod +x "$d/node/bin/node"
  printf '[Service]\nExecStart=/x %s\n' "$v" > "$d/deploy/systemd/openpassword-broker.service"
  printf '[Service]\nExecStart=/y %s\n' "$v" > "$d/deploy/systemd/openpassword-web.service"
  printf '{"name":"openpassword","platform":"linux","version":"%s","arch":"%s","commit":"%s"}\n' "$v" "$arch" "$commit" > "$d/RELEASE.json"
  tar -czf "$t/openpassword-$v.tar.gz" -C "$d" .
  sha256sum "$t/openpassword-$v.tar.gz" | cut -d' ' -f1 > "$t/sha-$v"
}
mkrel 0.3.0; mkrel 0.3.1; mkrel 0.3.2

printf 'CANARY-SETUP-CODE\n' > "$t/state/operator.token"
export OPENPASSWORD_PREFIX=$t/prefix OPENPASSWORD_UNITS_DIR=$t/units OPENPASSWORD_STATE_DIR=$t/state OPENPASSWORD_PROC=$t/proc
export OPENPASSWORD_SYSTEMCTL=$t/bin/systemctl OPENPASSWORD_SYSTEMD_RUN=$t/bin/systemd-run OPENPASSWORD_CURL=$t/bin/curl
export OPENPASSWORD_INSTALL=$t/bin/install OPENPASSWORD_SNAPSHOT_CP=$t/bin/cp OPENPASSWORD_LN=$t/bin/ln
export OPENPASSWORD_NODE_PIN=$pin OPENPASSWORD_ALLOW_NONROOT=1 OPENPASSWORD_READY_TRIES=2 OPENPASSWORD_READY_SLEEP=0
run() { # version [extra args]; prints JSON to $t/out, returns the exit code
  local v=$1; shift
  bash deploy/install.sh agent "${MODE:-apply}" --archive "$t/openpassword-$v.tar.gz" --sha256 "${SHA:-$(cat "$t/sha-$v")}" \
    --commit "${COMMIT:-$commit}" --version "$v" --arch "$arch" --origin "${ORIGIN:-https://pass.example.com}" "$@" > "$t/out" 2> "$t/err" || return $?
}
state() { "$real_node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).state' "$t/out"; }
code() { "$real_node" -p '(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).error||{}).code||""' "$t/out"; }
json_ok() { "$real_node" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$t/out" || fail "output is not JSON"; }
# Everything the switch touches, for before/after comparison (kept baselines and staging are not included).
snap() { ( cd "$t"; { readlink prefix/current || echo none; for f in units/*.service units/openpassword-broker.service.d/* prefix/installed.json; do [ -f "$f" ] && { echo "$f"; cat "$f"; }; done; ls prefix/releases | grep -v '^\.' || true; } | sha256sum ); }
serving_release() { # service: which release directory the stub process runs in
  local pid; pid=$(cat "$t/pids/$1" 2>/dev/null) || { echo none; return; }
  readlink -f "$t/proc/$pid/cwd"
}
restart_stubs() { # a healthy running host again
  rm -f "${t:?}"/pids/openpassword-*
  for s in openpassword-broker openpassword-web; do "$t/bin/systemctl" start "$s"; done
}

# 1. plan changes nothing.
MODE=plan run 0.3.0 || fail "plan failed"; json_ok; [ "$(state)" = ready ] || fail "plan state"
[ ! -e "$t/prefix/current" ] || fail "plan installed something"

# 2. a wrong digest, a wrong commit and a malformed version are refused and leave no release.
SHA=$(printf 'a%.0s' $(seq 64)) run 0.3.0 && fail "wrong digest accepted"; json_ok; [ "$(code)" = digest_mismatch ] || fail "digest code: $(code)"
COMMIT=ffffffffffffffffffffffffffffffffffffffff run 0.3.0 && fail "wrong commit accepted"; [ "$(code)" = identity_mismatch ] || fail "commit code: $(code)"
[ ! -e "$t/prefix/current" ] && [ -z "$(ls -A "$t/prefix/releases" 2>/dev/null)" ] || fail "a refusal left files behind"

# 3. fresh install: needs_human with the setup-code PATH, no secret in output, services running from 0.3.0.
rc=0; run 0.3.0 || rc=$?; json_ok; [ "$rc" = 10 ] && [ "$(state)" = needs_human ] || fail "fresh install state $(state) rc $rc ($(code))"
[ "$(readlink "$t/prefix/current")" = releases/0.3.0 ] || fail "current is not 0.3.0"
[ "$(serving_release openpassword-broker)" = "$(readlink -f "$t/prefix/releases/0.3.0")" ] || fail "the broker does not serve 0.3.0"
grep -q "$t/state/operator.token" "$t/out" || fail "setup-code path not returned"
grep -rq CANARY "$t/out" "$t/err" && fail "the setup code was printed"
grep -q 'OPENPASSWORD_WEB_ORIGIN=https://pass.example.com' "$t/units/openpassword-broker.service.d/origin.conf" || fail "origin drop-in"
[ -f "$t/prefix/installed.json" ] || fail "no install record"

# 4. rerun re-verifies and changes nothing.
: > "$t/log"; run 0.3.0 || fail "rerun failed ($(code))"; [ "$(state)" = ready ] || fail "rerun state"
grep -q 'stop' "$t/log" && fail "rerun restarted services"

# 5. upgrade to 0.3.1 works and keeps the previous release.
run 0.3.1 || fail "upgrade failed ($(code))"; [ "$(state)" = ready ] || fail "upgrade state"
[ "$(readlink "$t/prefix/current")" = releases/0.3.1 ] && [ -d "$t/prefix/releases/0.3.0" ] || fail "upgrade layout"
[ "$(serving_release openpassword-web)" = "$(readlink -f "$t/prefix/releases/0.3.1")" ] || fail "the console does not serve 0.3.1"

# 6a. a release that never becomes ready is rolled back: previous symlink, units, drop-in and record are
# back, the previous release is running again and the failure is reported as readiness_failed.
before=$(snap); : > "$t/log"
rc=0; ORIGIN=https://other.example.com STUB_UNHEALTHY_AT=releases/0.3.2 run 0.3.2 || rc=$?
[ "$rc" = 1 ] && [ "$(code)" = readiness_failed ] || fail "readiness failure: rc $rc code $(code)"
[ "$(snap)" = "$before" ] || fail "host state changed after a rolled-back readiness failure"
grep -q 'https://pass.example.com' "$t/units/openpassword-broker.service.d/origin.conf" || fail "the origin drop-in was not restored"
[ "$(serving_release openpassword-broker)" = "$(readlink -f "$t/prefix/releases/0.3.1")" ] || fail "after rollback the broker does not serve 0.3.1"
[ "$(serving_release openpassword-web)" = "$(readlink -f "$t/prefix/releases/0.3.1")" ] || fail "after rollback the console does not serve 0.3.1"
grep -q '^start openpassword-web' "$t/log" || fail "rollback did not restart the console"

# 6b. when the previous release cannot be brought back either, the answer is rollback_failed (and the files
# are still restored).
before=$(snap)
rc=0; STUB_UNHEALTHY=1 run 0.3.2 || rc=$?
[ "$rc" = 1 ] && [ "$(code)" = rollback_failed ] || fail "failed recovery: rc $rc code $(code)"
[ "$(snap)" = "$before" ] || fail "files were not restored after a failed recovery"
ls "$t"/prefix/.snap-* >/dev/null 2>&1 || fail "the baseline was not kept after a failed recovery"
drop_baselines
restart_stubs

# 6c. a write failure at each step of the switch leaves the previous host unchanged and running.
for n in 1 2 3; do
  before=$(snap); : > "$t/log"; resetcount
  rc=0; STUB_INSTALL_FAIL=$n ORIGIN=https://other.example.com run 0.3.2 || rc=$?
  [ "$rc" = 1 ] && [ "$(code)" = switch_failed ] || fail "write failure $n: rc $rc code $(code)"
  [ "$(snap)" = "$before" ] || fail "write failure $n left a partially switched host"
  grep -q 'https://pass.example.com' "$t/units/openpassword-broker.service.d/origin.conf" || fail "write failure $n: origin drop-in"
done

# 6d. a failed baseline capture aborts before any live change: untouched host, no service operation, and
# the live files are never treated as absent (four captures: two units, the drop-in, the record).
for n in 1 2 3 4; do
  before=$(snap); : > "$t/log"; resetcount
  rc=0; STUB_CP_FAIL=$n ORIGIN=https://other.example.com run 0.3.2 || rc=$?
  [ "$rc" = 1 ] && [ "$(code)" = snapshot_failed ] || fail "capture failure $n: rc $rc code $(code)"
  [ "$(snap)" = "$before" ] || fail "capture failure $n changed the host"
  [ ! -s "$t/log" ] || fail "capture failure $n touched a service"
  if ls "$t"/prefix/.snap-* >/dev/null 2>&1; then fail "capture failure $n left a baseline directory"; fi
done

# 6e. activation must really succeed and the serving process must be the new release's. Each fault below
# lets "start" or the health probe look fine while the old process keeps serving, so the record must not
# be committed and the previous state must be restored. The same fault also breaks the recovery, so the
# honest answer is rollback_failed with the files restored.
for fault in STUB_STALE STUB_STOP_FAIL STUB_RELOAD_FAIL STUB_WRONGCWD; do
  before=$(snap); rc=0
  ( export "$fault=1"; ORIGIN=https://other.example.com run 0.3.2 ) || rc=$?
  [ "$rc" = 1 ] && [ "$(code)" = rollback_failed ] || fail "$fault: rc $rc code $(code)"
  [ "$(snap)" = "$before" ] || fail "$fault: the host changed or the record was committed"
  drop_baselines
  restart_stubs
done

# 6f. a failed first install leaves nothing behind.
rm -rf "${t:?}/prefix2" "${t:?}/units2"; mkdir -p "$t/units2"
fresh() { OPENPASSWORD_PREFIX=$t/prefix2 OPENPASSWORD_UNITS_DIR=$t/units2 "$@"; }
resetcount; rc=0; STUB_INSTALL_FAIL=2 fresh run 0.3.0 || rc=$?
[ "$rc" = 1 ] && [ "$(code)" = switch_failed ] || fail "fresh install failure: rc $rc code $(code)"
[ ! -e "$t/prefix2/current" ] && [ ! -e "$t/prefix2/installed.json" ] && [ -z "$(ls -A "$t/units2")" ] && [ -z "$(ls "$t/prefix2/releases" | grep -v '^\.' || true)" ] || fail "a failed fresh install left files behind"

# 6g. only one apply runs at a time.
rc=0; ( flock -n 8 || exit 9; run 0.3.2 ) 8> "$t/prefix/.apply.lock" || rc=$?
[ "$rc" = 1 ] && [ "$(code)" = lock_busy ] || fail "a concurrent apply was not refused: rc $rc code $(code)"

# 6h. rerunning the installed version re-verifies the supplied artifact, commit, origin, host and processes.
run 0.3.1 || fail "same-version rerun failed ($(code))"; [ "$(state)" = ready ] || fail "same-version state"
rc=0; SHA=$(cat "$t/sha-0.3.2") run 0.3.1 || rc=$?; [ "$rc" = 1 ] && [ "$(code)" = digest_mismatch ] || fail "same version, other digest: rc $rc $(code)"
rc=0; COMMIT=ffffffffffffffffffffffffffffffffffffffff run 0.3.1 || rc=$?; [ "$rc" = 1 ] && [ "$(state)" = failed ] || fail "same version, other commit accepted: rc $rc"
rc=0; ORIGIN=https://other.example.com run 0.3.1 || rc=$?; [ "$rc" = 1 ] && [ "$(code)" = origin_differs ] || fail "same version, other origin: rc $rc $(code)"
cp "$t/units/openpassword-broker.service.d/origin.conf" "$t/origin.keep"
printf '[Service]\nEnvironment=OPENPASSWORD_WEB_ORIGIN=https://evil.example.com\n' > "$t/units/openpassword-broker.service.d/origin.conf"
rc=0; run 0.3.1 || rc=$?; [ "$rc" = 1 ] && [ "$(code)" = origin_drift ] || fail "drifted drop-in: rc $rc $(code)"
cp "$t/origin.keep" "$t/units/openpassword-broker.service.d/origin.conf"
cp "$t/units/openpassword-web.service" "$t/web.keep"; echo '# drift' >> "$t/units/openpassword-web.service"
rc=0; run 0.3.1 || rc=$?; [ "$rc" = 1 ] && [ "$(code)" = unit_drift ] || fail "drifted unit: rc $rc $(code)"
cp "$t/web.keep" "$t/units/openpassword-web.service"
mv "$t/prefix/installed.json" "$t/record.keep"
rc=0; run 0.3.1 || rc=$?; [ "$rc" = 1 ] && [ "$(code)" = unrecorded_install ] || fail "unrecorded install: rc $rc $(code)"
mv "$t/record.keep" "$t/prefix/installed.json"
# An old process still serving (its working directory is another release) is not ready, even though the files match.
pid=$(cat "$t/pids/openpassword-broker"); keep=$(readlink "$t/proc/$pid/cwd"); ln -sfn "$t/prefix/releases/0.3.0" "$t/proc/$pid/cwd"
rc=0; run 0.3.1 || rc=$?; [ "$rc" = 1 ] && [ "$(code)" = not_serving_release ] || fail "stale process accepted: rc $rc $(code)"
ln -sfn "$keep" "$t/proc/$pid/cwd"
run 0.3.1 || fail "the restored host should verify again"

# 7. status.
MODE=status run 0.3.1 || fail "status failed"; [ "$(state)" = ready ] || fail "status state"
STUB_INACTIVE=1 MODE=status run 0.3.1 && fail "inactive service reported ready"

# 8. if restoring the previous symlink fails, the new release directory is preserved (it may be in use).
resetcount; rc=0; STUB_LN_FAIL=2 ORIGIN=https://other.example.com STUB_UNHEALTHY_AT=releases/0.3.2 run 0.3.2 || rc=$?
[ "$rc" = 1 ] && [ "$(code)" = rollback_failed ] || fail "failed link restore: rc $rc code $(code)"
[ -d "$t/prefix/releases/0.3.2" ] || fail "the new release was deleted although the link was not restored"
echo "installer-test: ok"
