#!/usr/bin/env bash
# Build and package a release from one exact commit.
#   scripts/package.sh <expected-commit>
# The expected commit is resolved once. After the pin check every Git read uses that commit, and the
# release is built from `git archive <commit>` in a scratch directory, so ignored or stale
# build output, untracked files and any .env* cannot reach the archive. The archive root is the
# release directory itself: extracted into /opt/openpassword/releases/<version> its entry points
# sit where the systemd units' WorkingDirectory (/opt/openpassword/current) resolves.
# Output (dist-release/): <name>.tar.gz, RELEASE.json, <name>.complete (written last).
set -euo pipefail
umask 022
cd "$(dirname "$0")/.."

NODE_PIN=v24.19.0
expected=${1:-}
[ -n "$expected" ] || { echo "package: usage: scripts/package.sh <expected-commit>" >&2; exit 2; }
[ "$(uname -s)" = Linux ] || { echo "package: releases are built on Linux only" >&2; exit 1; }
tar_version=$(tar --version)
grep -q 'GNU tar' <<<"$tar_version" || { echo "package: GNU tar is required" >&2; exit 1; }
node_version=$(node -p process.version)
[ "$node_version" = "$NODE_PIN" ] || { echo "package: Node $node_version is not the pinned $NODE_PIN" >&2; exit 1; }

# next build may rewrite next-env.d.ts; the release is built from the pinned commit's `git archive`, so it cannot leak in.
dirty=$(git status --porcelain --ignored=no -- . ':!next-env.d.ts')
[ -z "$dirty" ] || { echo "package: working tree is not clean" >&2; exit 1; }
commit=$(git rev-parse --verify "$expected^{commit}")
head=$(git rev-parse HEAD)
[ "$head" = "$commit" ] || { echo "package: HEAD $head is not the expected commit $commit" >&2; exit 1; }
# From here on only $commit is read; HEAD and the checkout are not consulted again.
tree=$(git rev-parse --verify "$commit^{tree}")
epoch=$(git log -1 --format=%ct "$commit")
[[ "$epoch" =~ ^[0-9]+$ ]] || { echo "package: no commit time" >&2; exit 1; }
tracked=$(git ls-tree -r --name-only "$commit")
if grep -Eq '(^|/)\.env' <<<"$tracked"; then echo "package: a tracked .env file exists" >&2; exit 1; fi

sha() { local h; h=$(sha256sum "$1" | cut -d' ' -f1); [[ "$h" =~ ^[0-9a-f]{64}$ ]] || { echo "package: bad digest for $1" >&2; return 1; }; printf '%s\n' "$h"; }
root=$PWD
out=$root/dist-release
rm -rf "$out"
mkdir -p "$out/build" "$out/stage"
trap 'rm -f "$out"/*.partial' EXIT

# 1. Build the exact commit in a scratch directory.
git archive "$commit" | tar -x -C "$out/build"
export SOURCE_DATE_EPOCH=$epoch
# Fixed build id: Next would otherwise write a random one into .next.
export OPENPASSWORD_BUILD_ID=$commit
[ -n "$OPENPASSWORD_BUILD_ID" ] || { echo "package: empty build id" >&2; exit 1; }
# Version, lockfile and Makefile are read from the exported files, not the checkout.
version=$(node -p "require('$out/build/package.json').version")
machine=$(uname -m)
case "$machine" in aarch64|arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) arch=$machine ;; esac
name="openpassword-$version-linux-$arch"
(
  cd "$out/build"
  npm ci
  npm run packages
  npm run build
  npm prune --omit=dev
)
dev_only=$(node -e "const p=require('$out/build/package.json');for(const k of Object.keys(p.devDependencies||{}))if(!(p.dependencies||{})[k])console.log(k)")
for k in $dev_only; do
  [ ! -e "$out/build/node_modules/$k" ] || { echo "package: development dependency $k survived the prune" >&2; exit 1; }
done
source_listing=$(tar -tzf "$out/build/public/openpassword-source.tar.gz")
script_refs=$(grep -o 'scripts/[a-z-]*\.sh' "$out/build/Makefile" | sort -u)
for f in $script_refs; do
  grep -qx "$f" <<<"$source_listing" \
    || { echo "package: $f is missing from the corresponding-source archive" >&2; exit 1; }
done

# 2. Stage an explicit runtime payload.
payload=(package.json package-lock.json tsconfig.json next.config.ts next-env.d.ts LICENSE README.md CHANGELOG.md PARITY.md app deploy docs public server packages .next node_modules)
for p in "${payload[@]}"; do [ -e "$out/build/$p" ] || { echo "package: missing $p in the build" >&2; exit 1; }; done
tar -C "$out/build" --exclude=.next/cache --exclude='.env*' --exclude='packages/*/node_modules' -cf - "${payload[@]}" | tar -xf - -C "$out/stage"
rm -rf "$out/stage/.next/cache"
stray=$(find "$out/stage" -name '.env*')
if [ -n "$stray" ]; then echo "package: .env file in payload" >&2; exit 1; fi

# 3. Provenance.
lock=$(sha "$out/build/package-lock.json")
node_path=$(command -v node)
node_sha=$(sha "$node_path")
node - "$commit" "$tree" "$version" "$arch" "$node_version" "$node_sha" "$lock" "$epoch" > "$out/stage/RELEASE.json" <<'JS'
const [commit, tree, version, arch, node, node_binary_sha256, lockfile_sha256, source_epoch] = process.argv.slice(2)
console.log(JSON.stringify({ name: 'openpassword', version, commit, tree, platform: 'linux', arch, node, node_binary_sha256, lockfile_sha256, source_epoch: Number(source_epoch) }, null, 2))
JS

# 4. Deterministic archive, written under a temporary name and renamed only when complete.
tmp=$out/$name.tar.gz.partial
tar -C "$out/stage" --mode=u+rwX,go+rX,go-w --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner --format=gnu -cf - . | gzip -n > "$tmp"
listing=$(tar -tzf "$tmp")
for must in ./RELEASE.json ./server/main.ts ./packages/cli/dist/index.js ./.next/BUILD_ID ./node_modules/next/dist/bin/next; do
  grep -qx "$must" <<<"$listing" || { rm -f "$tmp"; echo "package: archive lacks $must" >&2; exit 1; }
done
if grep -Eq '(^|/)\.env|^\./\.next/cache|^\./node_modules/(playwright|playwright-core)(/|$)' <<<"$listing"; then rm -f "$tmp"; echo "package: archive contains excluded files" >&2; exit 1; fi
mv "$tmp" "$out/$name.tar.gz"
cp "$out/stage/RELEASE.json" "$out/RELEASE.json"
rm -rf "$out/build" "$out/stage"
archive_sha=$(sha "$out/$name.tar.gz")
printf '%s  %s\n' "$archive_sha" "$name.tar.gz" > "$out/$name.complete"
echo "$out/$name.tar.gz"
