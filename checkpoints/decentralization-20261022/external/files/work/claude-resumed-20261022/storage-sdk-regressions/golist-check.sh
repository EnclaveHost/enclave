#!/bin/bash
# light, offline: the derived harness modfiles resolve every package of ./cmd/harness-block from the existing module
# cache and the accepted snapshots, with -mod=readonly (nothing can be rewritten). No compile.
set -euo pipefail
S=$(cd "$(dirname "$0")" && pwd); cd "$S/harness-src"
c=$(mktemp -d "$S/.golist-cache.XXXX"); trap 'rm -rf "$c"' EXIT
before=$(sha256sum go.*)
for k in c2e fe; do
  n=$(GOCACHE=$c GOTOOLCHAIN=local GOPROXY=off GOFLAGS=-mod=readonly GOMAXPROCS=2 CGO_ENABLED=0 taskset -c 0-1 go list -deps -modfile go.$k.mod ./cmd/harness-block | wc -l)
  dir=$(GOCACHE=$c GOTOOLCHAIN=local GOPROXY=off GOFLAGS=-mod=readonly CGO_ENABLED=0 go list -modfile go.$k.mod -f '{{.Module.Dir}}' go.sia.tech/indexd/contracts)
  echo "$k: $n packages resolve offline; go.sia.tech/indexd/contracts from $dir"
done
[ "$before" = "$(sha256sum go.*)" ] && echo "modfiles/sums unchanged"
