#!/bin/sh
# Assemble a release archive from an already built tree (run `make verify` or `make build` first).
# Output: dist-release/openpassword-<version>-linux-<arch>.tar.gz and RELEASE.json
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Linux ] || [ "${OPENPASSWORD_PACKAGE_ANY_OS:-}" = 1 ] || { echo "package: Linux only (set OPENPASSWORD_PACKAGE_ANY_OS=1 to override)" >&2; exit 1; }
[ -d .next ] && [ -d packages/cli/dist ] || { echo "package: build first (make build)" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "package: working tree is not clean" >&2; exit 1; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
version=$(node -p "require('./package.json').version")
case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) arch=$(uname -m) ;; esac
name="openpassword-$version-linux-$arch"
out=dist-release
rm -rf "$out"
mkdir -p "$out/stage/$name"
commit=$(git rev-parse HEAD)
tree=$(git rev-parse HEAD^{tree})
node - "$commit" "$tree" "$version" "$arch" "$(node -p process.version)" "$(sha package-lock.json)" "$(sha "$(command -v node)")" > "$out/stage/$name/RELEASE.json" <<'JS'
const [commit, tree, version, arch, node, lockfile_sha256, node_binary_sha256] = process.argv.slice(2)
console.log(JSON.stringify({ name: 'openpassword', version, commit, tree, platform: 'linux', arch, node, node_binary_sha256, lockfile_sha256 }, null, 2))
JS
# Tracked source, plus build output and installed dependencies.
{ git ls-files; find .next packages/*/dist public/openpassword-source.tar.gz node_modules -type f -o -type l; } \
  | sort -u | tar -cf - -T - | tar -xf - -C "$out/stage/$name"
tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$out/$name.tar.gz" -C "$out/stage" "$name" 2>/dev/null \
  || tar -czf "$out/$name.tar.gz" -C "$out/stage" "$name"
cp "$out/stage/$name/RELEASE.json" "$out/RELEASE.json"
rm -rf "$out/stage"
echo "$out/$name.tar.gz"
