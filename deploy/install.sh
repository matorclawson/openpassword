#!/usr/bin/env bash
# OpenPassword installer. Runs ON the target Linux host, as root, against a gated release archive.
#   install.sh agent plan   --archive F --sha256 H --commit C --version V --arch A --origin URL
#   install.sh agent apply  (same options)
#   install.sh agent status
# Every subcommand prints ONE JSON object on stdout: state (ready | needs_human | failed), checks[],
# needs_human[], urls, error. Exit codes: 0 ready, 10 needs_human, 1 failed, 2 bad usage.
# The installer never builds, never downloads and never prints a secret: for the administrator
# account it returns the PATH of the setup-code file, not its content. apply is transactional: it
# stages and verifies, captures a complete baseline (symlink, units, origin drop-in, install record) before
# any live change, then switches and activates; on any failure it restores the baseline. Activation must
# succeed on every service operation and the serving processes must be the new release's. Rerunning the
# installed version re-verifies it against the install record, the host and the running processes. One
# apply runs at a time. The upgrade sequence the external council is porting
# (disposable-vault preflight, drain, interrupted-activation recovery) plugs into the marked seams.
set -euo pipefail
umask 022

PREFIX=${OPENPASSWORD_PREFIX:-/opt/openpassword}
UNITS=${OPENPASSWORD_UNITS_DIR:-/etc/systemd/system}
STATE=${OPENPASSWORD_STATE_DIR:-/var/lib/openpassword}
SYSTEMCTL=${OPENPASSWORD_SYSTEMCTL:-systemctl}
SYSTEMD_RUN=${OPENPASSWORD_SYSTEMD_RUN:-systemd-run}
CURL=${OPENPASSWORD_CURL:-curl}
INSTALL=${OPENPASSWORD_INSTALL:-install}
SNAPCP=${OPENPASSWORD_SNAPSHOT_CP:-cp}
LN=${OPENPASSWORD_LN:-ln}
PROC=${OPENPASSWORD_PROC:-/proc}
NODE_PIN=${OPENPASSWORD_NODE_PIN:-v24.19.0}
BROKER_URL=${OPENPASSWORD_BROKER_URL:-http://127.0.0.1:4141}
WEB_URL=${OPENPASSWORD_WEB_URL:-}   # normally read from the release's own web unit, see web_url
READY_TRIES=${OPENPASSWORD_READY_TRIES:-30}
SERVICES=(openpassword-broker openpassword-web)

cmd=${1:-}; sub=${2:-}
[ "$cmd" = agent ] && [[ "$sub" =~ ^(plan|apply|status)$ ]] || { echo '{"state":"failed","error":{"code":"usage","message":"usage: install.sh agent plan|apply|status [options]"}}'; exit 2; }
shift 2
ARCHIVE= SHA256= COMMIT= VERSION= ARCH= ORIGIN=
while [ $# -gt 0 ]; do
  case $1 in
    --archive) ARCHIVE=${2:-}; shift 2 ;;
    --sha256) SHA256=${2:-}; shift 2 ;;
    --commit) COMMIT=${2:-}; shift 2 ;;
    --version) VERSION=${2:-}; shift 2 ;;
    --arch) ARCH=${2:-}; shift 2 ;;
    --origin) ORIGIN=${2:-}; shift 2 ;;
    *) echo '{"state":"failed","error":{"code":"usage","message":"unknown option"}}'; exit 2 ;;
  esac
done

# ---- JSON output -------------------------------------------------------------------------------
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/ /g' | tr '\n' ' '; }
CHECKS=() HUMAN=()
check() { CHECKS+=("{\"name\":\"$(esc "$1")\",\"status\":\"$2\",\"detail\":\"$(esc "${3:-}")\"}"); }
human() { HUMAN+=("{\"step\":\"$(esc "$1")\",\"where\":\"$(esc "$2")\",\"instructions\":\"$(esc "$3")\"}"); }
join() { local IFS=,; echo "$*"; }
finish() { # state code message
  local state=$1 code=${2:-} msg=${3:-} err=null
  [ -n "$code" ] && err="{\"code\":\"$(esc "$code")\",\"message\":\"$(esc "$msg")\"}"
  printf '{"state":"%s","version":"%s","checks":[%s],"needs_human":[%s],"urls":{"console":"%s"},"error":%s}\n' \
    "$state" "$(esc "$VERSION")" "$(join "${CHECKS[@]+"${CHECKS[@]}"}")" "$(join "${HUMAN[@]+"${HUMAN[@]}"}")" "$(esc "$ORIGIN")" "$err"
  case $state in ready) exit 0 ;; needs_human) exit 10 ;; *) exit 1 ;; esac
}
fail() { check "$1" fail "$3"; finish failed "$2" "$3"; }

# ---- inputs and host ---------------------------------------------------------------------------
validate_inputs() {
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail inputs bad_version "--version must look like 0.3.0"
  [[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || fail inputs bad_sha256 "--sha256 must be 64 lowercase hex characters"
  [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail inputs bad_commit "--commit must be a 40 character commit id"
  [[ "$ARCH" =~ ^[a-z0-9_]+$ ]] || fail inputs bad_arch "--arch is missing or malformed"
  [[ "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+$ ]] || fail inputs bad_origin "--origin must be an https origin without a path or port"
  [ -f "$ARCHIVE" ] || fail inputs no_archive "the archive file was not found"
  check inputs ok "version, digest, commit, arch, origin and archive given"
}
check_host() {
  [ "$(uname -s)" = Linux ] || fail host not_linux "this installer runs on Linux"
  local m; case "$(uname -m)" in aarch64|arm64) m=arm64 ;; x86_64) m=x64 ;; *) m=$(uname -m) ;; esac
  [ "$m" = "$ARCH" ] || fail host arch_mismatch "the archive is $ARCH but this host is $m"
  [ "$sub" = plan ] || [ "${OPENPASSWORD_ALLOW_NONROOT:-}" = 1 ] || [ "$(id -u)" = 0 ] || fail host not_root "run as root"
  command -v "$SYSTEMCTL" >/dev/null || fail host no_systemd "systemctl was not found"
  check host ok "linux $m, root, systemd present"
}
current_version() {
  [ -L "$PREFIX/current" ] || return 1
  local t; t=$(readlink "$PREFIX/current"); printf '%s\n' "${t##*/}"
}
DROPDIR=$UNITS/openpassword-broker.service.d
DROP=$DROPDIR/origin.conf
RECORD=$PREFIX/installed.json
drop_in_text() { printf '[Service]\nEnvironment=OPENPASSWORD_WEB_ORIGIN=%s\n' "$ORIGIN"; }
record_text() { printf '{"version":"%s","arch":"%s","commit":"%s","sha256":"%s","origin":"%s"}\n' "$VERSION" "$ARCH" "$COMMIT" "$SHA256" "$ORIGIN"; }

# ---- steps; the marked seams are where the council's upgrade sequence plugs in ------------------
step_copy() { # copy the archive into a private staging directory and check it against the trusted digest
  STAGE=$(mktemp -d "$PREFIX/.stage-XXXXXX"); chmod 700 "$STAGE"
  cp -- "$ARCHIVE" "$STAGE/release.tar.gz"
  local got; got=$(sha256sum "$STAGE/release.tar.gz" | cut -d' ' -f1)
  [ "$got" = "$SHA256" ] || fail archive digest_mismatch "the staged archive digest does not match --sha256"
  check archive ok "staged copy matches the trusted digest"
}
step_stage() {
  step_copy
  NEW=$(mktemp -d "$PREFIX/releases/.new-XXXXXX")
  tar -xzf "$STAGE/release.tar.gz" -C "$NEW" --no-same-owner
  chmod 755 "$NEW"
}
step_verify() { # dir: a release directory, identity checked against the requested version, arch and commit
  local d=$1 f
  for f in server/main.ts node_modules/next/dist/bin/next packages/cli/dist/index.js .next/BUILD_ID node_modules/tsx/package.json node/bin/node RELEASE.json deploy/systemd/openpassword-broker.service deploy/systemd/openpassword-web.service; do
    [ -f "$d/$f" ] || fail release missing_file "the release lacks $f"
  done
  # The proxy, the console rewrites and the probes dial 127.0.0.1, so the console must listen exactly there
  # ("localhost" can resolve to ::1 only).
  local bind; bind=$(web_unit_bind "$d/deploy/systemd/openpassword-web.service")
  [ -n "$bind" ] && [ "${bind%% *}" = 127.0.0.1 ] || fail release web_bind "the console unit's ExecStart must run next start with -H 127.0.0.1 and a -p port (found: ${bind:-no bind})"
  SD=("$SYSTEMD_RUN" --quiet --pipe --wait --property=WorkingDirectory="$d" -p DynamicUser=yes -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes)
  local id
  id=$("${SD[@]}" "$d/node/bin/node" -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1] + "/RELEASE.json", "utf8"))
const [v, a, c] = process.argv.slice(2)
console.log(r.name === "openpassword" && r.platform === "linux" && r.version === v && r.arch === a && r.commit === c ? "match" : "mismatch")
' "$d" "$VERSION" "$ARCH" "$COMMIT") || fail release probe_failed "the release could not be read under the unit sandbox"
  [ "$id" = match ] || fail release identity_mismatch "RELEASE.json does not match the requested version, arch and commit"
  local v; v=$("${SD[@]}" "$d/node/bin/node" -p process.version) || fail release probe_failed "the bundled Node did not run"
  [ "$v" = "$NODE_PIN" ] || fail release wrong_node "the bundled Node is $v, not $NODE_PIN"
  "${SD[@]}" "$d/node/bin/node" --import tsx -e 'require("fs").accessSync("server/main.ts", require("fs").constants.R_OK)' >/dev/null \
    || fail release broker_probe "the broker loader or entry point is not usable under the unit sandbox"
  "${SD[@]}" "$d/node/bin/node" node_modules/next/dist/bin/next --version >/dev/null \
    || fail release web_probe "the web launcher is not usable under the unit sandbox"
  check release ok "identity, bundled Node and both launchers verified under the unit sandbox"
}
step_preflight() { check preflight skipped "disposable-vault preflight is not implemented yet (seam for the council's port)"; }
step_drain() { check drain skipped "request drain is not implemented yet (seam for the council's port)"; }

# The baseline: everything the switch changes is captured and verified BEFORE any live change and before
# the transaction is armed. Each item records whether it was present or absent. If a capture fails, apply
# stops here and nothing live was touched; rollback only ever restores a complete, verified baseline.
capture() { # name path: present files are copied and compared, absent ones recorded, anything else refuses
  local name=$1 path=$2
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -f "$path" ] && [ ! -L "$path" ] || return 1
    "$SNAPCP" -p "$path" "$SNAP/$name" && cmp -s "$path" "$SNAP/$name" || return 1
    echo present > "$SNAP/$name.state" || return 1
  else
    echo absent > "$SNAP/$name.state" || return 1
  fi
}
step_snapshot() {
  local s
  SNAP=$(mktemp -d "$PREFIX/.snap-XXXXXX") || return 1
  chmod 700 "$SNAP" || return 1
  if [ -e "$PREFIX/current" ] || [ -L "$PREFIX/current" ]; then
    [ -L "$PREFIX/current" ] || return 1
    PREV=$(readlink "$PREFIX/current") || return 1
    [ -n "$PREV" ] || return 1
  else
    PREV=
  fi
  printf '%s\n' "$PREV" > "$SNAP/prev" || return 1
  for s in "${SERVICES[@]}"; do capture "$s.service" "$UNITS/$s.service" || return 1; done
  capture origin.conf "$DROP" || return 1
  capture installed.json "$RECORD" || return 1
  : > "$SNAP/COMPLETE" || return 1
}
step_switch() { # every command is checked: a failure returns, and the caller restores
  local s
  mv -T "$NEW" "$PREFIX/releases/$VERSION" || return 1; NEW=; CREATED=1
  "$LN" -sfn "releases/$VERSION" "$PREFIX/current.new" || return 1
  mv -T "$PREFIX/current.new" "$PREFIX/current" || return 1
  for s in "${SERVICES[@]}"; do "$INSTALL" -m 0644 "$PREFIX/current/deploy/systemd/$s.service" "$UNITS/$s.service" || return 1; done
  mkdir -p "$DROPDIR" || return 1
  drop_in_text > "$STAGE/origin.conf" || return 1
  "$INSTALL" -m 0644 "$STAGE/origin.conf" "$DROP" || return 1
  check switch ok "release $VERSION is current; units and origin drop-in installed"
}

# Activation: every service operation must succeed, and the process that serves must be the new one: its
# main PID differs from the one before the restart and its working directory is the release current points to.
pid_of() { "$SYSTEMCTL" show -p MainPID --value "$1" 2>/dev/null || echo 0; }
serving() { # service: the running main process belongs to the release `current` points to
  local pid; pid=$(pid_of "$1")
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [ "$(readlink -f "$PROC/$pid/cwd" 2>/dev/null)" = "$(readlink -f "$PREFIX/current")" ]
}
web_unit_bind() { # unit file: prints "host port" from the ExecStart line that runs `next start`; nothing unless both are there
  awk '/^ExecStart=/ && /next start/ { h = ""; p = ""
         for (i = 1; i <= NF; i++) { if ($i == "-H") h = $(i + 1); if ($i == "-p") p = $(i + 1) }
         if (h != "" && p ~ /^[0-9]+$/) { print h " " p; exit } }' "$1"
}
web_url() { # the address the console really listens on, read from the release's ExecStart; no default, no guess
  if [ -n "$WEB_URL" ]; then printf '%s/\n' "${WEB_URL%/}"; return; fi
  local b; b=$(web_unit_bind "$PREFIX/current/deploy/systemd/openpassword-web.service")
  [ -n "$b" ] || return 1
  printf 'http://%s:%s/\n' "${b%% *}" "${b##* }"
}
ready() { # both services answer
  local i url
  url=$(web_url) || return 1   # a unit without a readable bind is never ready
  for ((i = 0; i < READY_TRIES; i++)); do
    if "$CURL" -fsS --max-time 5 "$BROKER_URL/health" >/dev/null 2>&1 && "$CURL" -fsS --max-time 5 "$url" >/dev/null 2>&1; then return 0; fi
    sleep "${OPENPASSWORD_READY_SLEEP:-1}"
  done
  return 1
}
activate() {
  local s old_b old_w
  old_b=$(pid_of openpassword-broker); old_w=$(pid_of openpassword-web)
  "$SYSTEMCTL" daemon-reload || return 1
  "$SYSTEMCTL" stop openpassword-web openpassword-broker || return 1
  "$SYSTEMCTL" enable "${SERVICES[@]}" >/dev/null 2>&1 || return 1
  "$SYSTEMCTL" start openpassword-broker || return 1
  "$SYSTEMCTL" start openpassword-web || return 1
  ready || return 1
  for s in "${SERVICES[@]}"; do serving "$s" || return 1; done
  [ "$(pid_of openpassword-broker)" != "$old_b" ] || return 1
  [ "$(pid_of openpassword-web)" != "$old_w" ] || return 1
}
step_readiness() { activate; }
record_install() {
  record_text > "$RECORD.new" && mv -T "$RECORD.new" "$RECORD"
}
restore_item() { # name path
  local name=$1 path=$2
  case $(cat "$SNAP/$name.state" 2>/dev/null) in
    present) "$INSTALL" -m 0644 "$SNAP/$name" "$path" ;;
    absent) rm -f "${path:?}" ;;
    *) return 1 ;;
  esac
}
restore_files() { # undo the switch from the verified baseline; keeps going after an error and reports it
  local s rc=0 link_ok=1
  [ -n "${SNAP:-}" ] && [ -f "$SNAP/COMPLETE" ] || return 1
  if [ -n "$(cat "$SNAP/prev")" ]; then
    "$LN" -sfn "$(cat "$SNAP/prev")" "$PREFIX/current.new" && mv -T "$PREFIX/current.new" "$PREFIX/current" || { rc=1; link_ok=0; }
  else
    rm -f "${PREFIX:?}/current" || { rc=1; link_ok=0; }
  fi
  for s in "${SERVICES[@]}"; do restore_item "$s.service" "$UNITS/$s.service" || rc=1; done
  restore_item origin.conf "$DROP" || rc=1
  if [ "$(cat "$SNAP/origin.conf.state")" = absent ]; then rmdir "$DROPDIR" 2>/dev/null || true; fi
  restore_item installed.json "$RECORD" || rc=1
  # The new release directory is removed only when the previous link is back; otherwise it may be in use.
  if [ -n "${CREATED:-}" ] && [ $link_ok = 1 ]; then rm -rf "${PREFIX:?}/releases/${VERSION:?}" || rc=1; fi
  return $rc
}
step_rollback() {
  restore_files || return 1
  "$SYSTEMCTL" daemon-reload || return 1
  if [ -n "$(cat "$SNAP/prev")" ]; then activate; return; fi
  # A fresh install that failed leaves no release: stop and disable what the attempt started, and report
  # failure unless both services are really stopped and not enabled afterwards. A unit that was never
  # loaded may make stop or disable exit non-zero; the end state is what decides.
  local s rc=0
  "$SYSTEMCTL" stop openpassword-web openpassword-broker >/dev/null 2>&1 || true
  "$SYSTEMCTL" disable "${SERVICES[@]}" >/dev/null 2>&1 || true
  for s in "${SERVICES[@]}"; do
    if "$SYSTEMCTL" is-active --quiet "$s"; then rc=1; fi
    if "$SYSTEMCTL" is-enabled --quiet "$s" 2>/dev/null; then rc=1; fi
  done
  return $rc
}
human_steps() {
  human admin_account "$STATE/operator.token" "Read the setup code from this file on the server (do not paste it anywhere else) and enter it in the console at $ORIGIN to create the administrator account."
  human sign_in_providers "$ORIGIN/api/oauth/google/callback" "To use Google sign-in, create the OAuth application at the provider with this callback URL, then configure it in the console."
}

# ---- subcommands -------------------------------------------------------------------------------
status_cmd() {
  local v; v=$(current_version) || fail status not_installed "no release is installed"
  VERSION=$v
  local s
  for s in "${SERVICES[@]}"; do "$SYSTEMCTL" is-active --quiet "$s" && check "$s" ok active || fail "$s" inactive "$s is not active"; done
  ready || fail health unhealthy "the broker or console did not answer"
  for s in "${SERVICES[@]}"; do serving "$s" || fail "$s" not_serving_current "$s is not running from the current release"; done
  check health ok "broker and console answer from the current release"
  finish ready
}
plan_cmd() {
  validate_inputs; check_host
  local cur; cur=$(current_version || true)
  if [ "$cur" = "$VERSION" ]; then check plan ok "release $VERSION is already installed; apply would re-verify it"; else check plan ok "apply would install $VERSION (current: ${cur:-none})"; fi
  finish ready
}
# The installed release is the requested one only if the supplied artifact, commit and origin all match
# what was recorded at install time and what is on the host now, and the running processes belong to it.
# Anything else is a refusal, never "ready".
verify_installed() {
  local s
  step_copy
  [ "$(readlink "$PREFIX/current")" = "releases/$VERSION" ] || fail installed current_differs "current does not point at releases/$VERSION"
  [ -f "$RECORD" ] || fail installed unrecorded_install "release $VERSION was not installed by this installer, so its artifact and origin cannot be confirmed"
  grep -qF "\"sha256\":\"$SHA256\"" "$RECORD" || fail installed artifact_differs "the installed release was made from a different archive than --sha256"
  grep -qF "\"commit\":\"$COMMIT\"" "$RECORD" || fail installed commit_differs "the installed release records a different commit than --commit"
  grep -qF "\"origin\":\"$ORIGIN\"" "$RECORD" || fail installed origin_differs "the installed release was configured for a different origin than --origin"
  [ "$(drop_in_text)" = "$(cat "$DROP" 2>/dev/null)" ] || fail installed origin_drift "the origin drop-in on the host does not match --origin"
  for s in "${SERVICES[@]}"; do
    cmp -s "$PREFIX/current/deploy/systemd/$s.service" "$UNITS/$s.service" || fail installed unit_drift "$s.service on the host differs from the release"
  done
  step_verify "$PREFIX/releases/$VERSION"
  ready || fail health unhealthy "release $VERSION is installed but the services do not answer"
  for s in "${SERVICES[@]}"; do serving "$s" || fail installed not_serving_release "$s is not running from release $VERSION"; done
  check installed ok "digest, commit, origin, units, release identity and running processes match"
}
cleanup() { # temporary files always; an interrupted switch is restored too
  if [ "${TXN:-0}" = 1 ]; then TXN=0; restore_files >/dev/null 2>&1 || KEEP_SNAP=1; fi
  [ -n "${STAGE:-}" ] && rm -rf "${STAGE:?}"
  [ -n "${NEW:-}" ] && rm -rf "${NEW:?}"
  [ -n "${SNAP:-}" ] && [ -z "${KEEP_SNAP:-}" ] && rm -rf "${SNAP:?}"
  return 0
}
apply_cmd() {
  validate_inputs; check_host
  STAGE= NEW= PREV= CREATED= SNAP= KEEP_SNAP=
  TXN=0
  mkdir -p "$PREFIX/releases"; chmod 755 "$PREFIX"
  trap cleanup EXIT
  # One apply at a time: staging, baseline and the switch share the prefix.
  command -v flock >/dev/null || fail host no_flock "flock is required to serialize apply"
  exec 9> "$PREFIX/.apply.lock"
  flock -n 9 || fail lock lock_busy "another apply is running"
  local cur; cur=$(current_version || true)
  if [ "$cur" = "$VERSION" ]; then
    verify_installed
    finish ready
  fi
  step_stage; step_verify "$NEW"
  [ ! -e "$PREFIX/releases/$VERSION" ] || fail switch exists "releases/$VERSION already exists but is not the active release"
  step_preflight; step_drain
  step_snapshot || fail snapshot snapshot_failed "the current configuration could not be captured completely; nothing was changed"
  check snapshot ok "baseline captured and verified"
  TXN=1
  local rc=0
  step_switch || rc=1
  if [ $rc = 0 ]; then step_readiness || rc=2; fi
  if [ $rc = 0 ]; then record_install || rc=3; fi
  if [ $rc = 0 ]; then
    TXN=0
    check readiness ok "broker and console answer from the new release"
    if [ -z "$PREV" ]; then human_steps; finish needs_human; fi
    finish ready
  fi
  local code msg
  case $rc in
    1) code=switch_failed; msg="release $VERSION could not be switched in" ;;
    2) code=readiness_failed; msg="release $VERSION did not start as the serving release" ;;
    *) code=record_failed; msg="release $VERSION could not be recorded" ;;
  esac
  check switch fail "$msg"
  TXN=0
  if step_rollback; then
    check rollback ok "the previous state is restored${PREV:+ and running again}"
    finish failed "$code" "$msg; rolled back"
  fi
  KEEP_SNAP=1
  check rollback fail "rollback did not complete; the baseline is kept in $SNAP"
  finish failed rollback_failed "$msg and the rollback failed; inspect the host"
}
"${sub}_cmd"
