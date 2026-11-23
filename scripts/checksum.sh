#!/usr/bin/env bash
# Write the .sha256 sidecar, only for an archive that package.sh completed.
set -euo pipefail
cd "$(dirname "$0")/../dist-release" 2>/dev/null || { echo "checksum: no dist-release; run make package" >&2; exit 1; }
[ -f RELEASE.json ] || { echo "checksum: RELEASE.json missing" >&2; exit 1; }
shopt -s nullglob
found=0
for f in openpassword-*.tar.gz; do
  found=1
  name=${f%.tar.gz}
  [ -f "$name.complete" ] || { echo "checksum: $f has no completion marker" >&2; exit 1; }
  actual=$(sha256sum "$f" | cut -d' ' -f1)
  [ "$actual  $f" = "$(cat "$name.complete")" ] || { echo "checksum: $f does not match its completion marker" >&2; exit 1; }
  tar -xzOf "$f" ./RELEASE.json | cmp -s - RELEASE.json || { echo "checksum: $f does not carry this RELEASE.json" >&2; exit 1; }
  printf '%s  %s\n' "$actual" "$f" > "$f.sha256.partial"
  mv "$f.sha256.partial" "$f.sha256"
  cat "$f.sha256"
done
[ "$found" = 1 ] || { echo "checksum: no archive; run make package" >&2; exit 1; }
