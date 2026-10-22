#!/bin/bash
# storage-enclave-build A1 step 2 (light): toolchain pin + offline module resolution with -mod=readonly (nothing can be
# rewritten), and the needed modules' cache hashes against go.sum. No network: GOPROXY=off, GOTOOLCHAIN=local.
set -euo pipefail
B=$(cd "$(dirname "$0")" && pwd)
export GOTOOLCHAIN=local GOPROXY=off GOFLAGS=-mod=readonly GOMAXPROCS=2 GOMEMLIMIT=600MiB GOSUMDB=off
go version; go env GOROOT GOMODCACHE GOEXPERIMENT GOAMD64 GOVERSION
r=$(go env GOROOT); sha256sum "$r/bin/go" "$r/pkg/tool/linux_amd64/compile" "$r/pkg/tool/linux_amd64/link" "$r/VERSION" 2>/dev/null || sha256sum "$r/bin/go" "$r/pkg/tool/linux_amd64/compile" "$r/pkg/tool/linux_amd64/link"
for n in fence-enclave c2-enclave; do
  c=$(mktemp -d "$B/.precheck-cache.XXXX"); export GOCACHE=$c
  cd "$B/trees/$n"
  before=$(sha256sum go.mod go.sum)
  echo "== $n: $(taskset -c 0-1 go list -deps -test ./cmd/... ./contracts/... | wc -l) packages resolve offline (-mod=readonly)"
  python3 "$B/verify_needed_modules.py" .   # full `go mod verify` also needs modules the build never uses (precheck-1)
  [ "$before" = "$(sha256sum go.mod go.sum)" ] || { echo "go.mod/go.sum CHANGED"; exit 1; }
  rm -rf "$c"
done
