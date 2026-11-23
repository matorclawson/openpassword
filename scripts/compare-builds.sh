#!/usr/bin/env bash
# Compare the manifests of two builds of the same commit: scripts/compare-builds.sh <dirA> <dirB>
# Each dir is a dist-release directory. Exits 0 only if the manifests are identical.
set -euo pipefail
a=${1:?usage: compare-builds.sh <dirA> <dirB>}
b=${2:?usage: compare-builds.sh <dirA> <dirB>}
shopt -s nullglob
ma=("$a"/openpassword-*.manifest); mb=("$b"/openpassword-*.manifest)
[ "${#ma[@]}" = 1 ] && [ "${#mb[@]}" = 1 ] || { echo "compare: need exactly one manifest in each directory" >&2; exit 2; }
if diff -u "${ma[0]}" "${mb[0]}"; then echo "manifests identical (per-build files excluded: see RELEASE.json)"; else echo "compare: builds differ beyond the listed per-build files" >&2; exit 1; fi
