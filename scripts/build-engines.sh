#!/bin/sh
# Gate maintainer or developer, on the target build host, without sudo.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
# The two engines are built from the exact module versions in engines/go.mod; every module, theirs
# and their dependencies, must match engines/go.sum or the build stops. Needs network access to the Go
# module proxy, or a module cache that already holds these versions.
mkdir -p engine-bin
cd engines
export CGO_ENABLED=0 GOTOOLCHAIN=local GOWORK=off GOFLAGS=-mod=readonly
go mod download
go mod verify
for binary in dostoevsky-gateway ephemeral; do
  module=ephemeral
  [ "$binary" != dostoevsky-gateway ] || module=dostoevsky
  go build -trimpath -buildvcs=false -o "$root/engine-bin/$binary" "github.com/rodriveracom/$module/cmd/$binary"
done
