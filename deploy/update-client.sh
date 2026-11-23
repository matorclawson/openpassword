#!/bin/sh
# Install or update the standalone client in place. The next invocation uses it.
set -eu
origin=${OPENPASSWORD_BROKER:?Set OPENPASSWORD_BROKER to the installation origin}
origin=$(node -e '
const u=new URL(process.argv[1]);
if (u.username || u.password || u.pathname!=="/" || u.search || u.hash ||
 !(u.protocol==="https:" || (u.protocol==="http:" && ["localhost","127.0.0.1","[::1]"].includes(u.hostname)))) process.exit(1);
console.log(u.origin)' "$origin")
bin=${OPENPASSWORD_BIN_DIR:-"$HOME/.local/bin"}
mkdir -p "$bin"
stage=$(mktemp -d "$bin/.openpassword-update.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
curl -fsS --max-time 60 "$origin/openpassword-cli.cjs" -o "$stage/client.cjs"
curl -fsS --max-time 15 "$origin/openpassword-cli.sha256" -o "$stage/digest"
# OPENPASSWORD_CLI_SHA256, when set, is an independently obtained digest. It is checked BEFORE the
# downloaded file is ever executed (the version probe below runs it).
OPENPASSWORD_CLI_SHA256=${OPENPASSWORD_CLI_SHA256:-} node - "$stage" <<'JS'
const {readFileSync}=require('node:fs'),{createHash}=require('node:crypto');
const dir=process.argv[2];
const actual=createHash('sha256').update(readFileSync(dir+'/client.cjs')).digest('hex');
const pinned=process.env.OPENPASSWORD_CLI_SHA256;
if (pinned && pinned.trim().toLowerCase()!==actual) throw Error('CLI digest does not match OPENPASSWORD_CLI_SHA256. Nothing was run or installed.');
if (readFileSync(dir+'/digest','utf8').trim()!==actual) throw Error('CLI checksum mismatch. Retry once the server update finishes.');
JS
node "$stage/client.cjs" version >/dev/null
chmod 755 "$stage/client.cjs"
if [ -f "$bin/openpassword" ] && cmp -s "$bin/openpassword" "$stage/client.cjs"; then
  echo "CLI already current."
else
  mv -f "$stage/client.cjs" "$bin/openpassword"
  echo "Installed $bin/openpassword. Restart any long-running MCP client to load the update."
fi
