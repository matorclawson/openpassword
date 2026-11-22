#!/bin/sh
# Write a .sha256 sidecar for each archive in dist-release/.
set -eu
cd "$(dirname "$0")/../dist-release"
for f in openpassword-*.tar.gz; do
  [ -e "$f" ] || { echo "checksum: no archive; run make package" >&2; exit 1; }
  if command -v sha256sum >/dev/null; then sha256sum "$f" > "$f.sha256"; else shasum -a 256 "$f" > "$f.sha256"; fi
  cat "$f.sha256"
done
