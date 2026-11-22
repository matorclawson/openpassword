#!/usr/bin/env bash
# Build and package a release from one exact commit.
#   scripts/package.sh <expected-commit>
# The release is built from `git archive HEAD` in a scratch directory, so ignored or stale
# build output, untracked files and any .env* cannot reach the archive. The archive root is the
# release directory itself: extracted into /opt/openpassword/releases/<version> its entry points
# sit where the systemd units' WorkingDirectory (/opt/openpassword/current) resolves.
# Output (dist-release/): <name>.tar.gz, RELEASE.json, <name>.complete (written last).
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_PIN=v24.19.0
expected=${1:-}
[ -n "$expected" ] || { echo "package: usage: scripts/package.sh <expected-commit>" >&2; exit 2; }
[ "$(uname -s)" = Linux ] || { echo "package: releases are built on Linux only" >&2; exit 1; }
tar_version=$(tar --version)
grep -q 'GNU tar' <<<"$tar_version" || { echo "package: GNU tar is required" >&2; exit 1; }
node_version=$(node -p process.version)
[ "$node_version" = "$NODE_PIN" ] || { echo "package: Node $node_version is not the pinned $NODE_PIN" >&2; exit 1; }

# next build may rewrite next-env.d.ts; the release is built from `git archive HEAD`, so it cannot leak in.
[ -z "$(git status --porcelain --ignored=no -- . ':!next-env.d.ts')" ] || { echo "package: working tree is not clean" >&2; exit 1; }
commit=$(git rev-parse HEAD)
want=$(git rev-parse --verify "$expected^{commit}")
[ "$commit" = "$want" ] || { echo "package: HEAD $commit is not the expected commit $want" >&2; exit 1; }
tree=$(git rev-parse "HEAD^{tree}")
epoch=$(git log -1 --format=%ct)
tracked=$(git ls-files)
if grep -Eq '(^|/)\.env' <<<"$tracked"; then echo "package: a tracked .env file exists" >&2; exit 1; fi

sha() { sha256sum "$1" | cut -d' ' -f1; }
version=$(node -p "require('./package.json').version")
case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) arch=$(uname -m) ;; esac
name="openpassword-$version-linux-$arch"
root=$PWD
out=$root/dist-release
rm -rf "$out"
mkdir -p "$out/build" "$out/stage"

# 1. Build the exact commit in a scratch directory.
git archive HEAD | tar -x -C "$out/build"
export SOURCE_DATE_EPOCH=$epoch
(
  cd "$out/build"
  npm ci
  npm run packages
  npm run build
  npm prune --omit=dev
)
[ ! -e "$out/build/node_modules/playwright-core" ] || { echo "package: a development dependency survived the prune" >&2; exit 1; }
source_listing=$(tar -tzf "$out/build/public/openpassword-source.tar.gz")
for f in $(grep -o 'scripts/[a-z-]*\.sh' Makefile | sort -u); do
  grep -qx "$f" <<<"$source_listing" \
    || { echo "package: $f is missing from the corresponding-source archive" >&2; exit 1; }
done

# 2. Stage an explicit runtime payload.
payload=(package.json package-lock.json tsconfig.json next.config.ts next-env.d.ts LICENSE README.md CHANGELOG.md PARITY.md app deploy docs public server packages .next node_modules)
for p in "${payload[@]}"; do [ -e "$out/build/$p" ] || { echo "package: missing $p in the build" >&2; exit 1; }; done
tar -C "$out/build" --exclude=.next/cache --exclude='.env*' --exclude='packages/*/node_modules' -cf - "${payload[@]}" | tar -xf - -C "$out/stage"
rm -rf "$out/stage/.next/cache"
if [ -n "$(find "$out/stage" -name '.env*')" ]; then echo "package: .env file in payload" >&2; exit 1; fi

# 3. Provenance.
lock=$(sha package-lock.json)
node_sha=$(sha "$(command -v node)")
node - "$commit" "$tree" "$version" "$arch" "$node_version" "$node_sha" "$lock" "$epoch" > "$out/stage/RELEASE.json" <<'JS'
const [commit, tree, version, arch, node, node_binary_sha256, lockfile_sha256, source_epoch] = process.argv.slice(2)
console.log(JSON.stringify({ name: 'openpassword', version, commit, tree, platform: 'linux', arch, node, node_binary_sha256, lockfile_sha256, source_epoch: Number(source_epoch) }, null, 2))
JS

# 4. Deterministic archive, written under a temporary name and renamed only when complete.
tmp=$out/$name.tar.gz.partial
tar -C "$out/stage" --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner --format=gnu -cf - . | gzip -n > "$tmp"
listing=$(tar -tzf "$tmp")
for must in ./RELEASE.json ./server/main.ts ./packages/cli/dist/index.js ./.next/BUILD_ID ./node_modules/next/dist/bin/next; do
  grep -qx "$must" <<<"$listing" || { rm -f "$tmp"; echo "package: archive lacks $must" >&2; exit 1; }
done
if grep -Eq '(^|/)\.env|^\./\.next/cache|playwright' <<<"$listing"; then rm -f "$tmp"; echo "package: archive contains excluded files" >&2; exit 1; fi
mv "$tmp" "$out/$name.tar.gz"
cp "$out/stage/RELEASE.json" "$out/RELEASE.json"
rm -rf "$out/build" "$out/stage"
printf '%s  %s\n' "$(sha "$out/$name.tar.gz")" "$name.tar.gz" > "$out/$name.complete"
echo "$out/$name.tar.gz"
