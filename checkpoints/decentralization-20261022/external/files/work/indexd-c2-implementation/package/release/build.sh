#!/bin/bash
# Deterministic build of a release binary for the indexd replica rollout.
#   build.sh <source-dir> <output-file> [gocache-dir]
# Upstream recipe (Dockerfile / publish.yml): -tags='netgo timetzdata' -trimpath -a -ldflags '-s -w'.
# Additions, all for reproducibility and a static Linux binary: CGO_ENABLED=0, -buildid=, -buildvcs=false.
# Offline only: GOPROXY=off, GOFLAGS=-mod=mod (the module cache must already hold the pinned go.sum versions).
# Run ONLY through the shared queue: python3 work/claude-test-queue.py --mib 768 --log <log> -- build.sh ...
set -euo pipefail
src=$(cd "$1" && pwd); out=$2; cache=${3:-}
[ -n "$cache" ] && export GOCACHE=$cache
cd "$src"
export CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOPROXY=off GOFLAGS=${MODFLAG:--mod=mod} GOMEMLIMIT=600MiB GOMAXPROCS=2
taskset -c 0-1 go build -p 1 -o "$out" -tags='netgo timetzdata' -trimpath -a -buildvcs=false -ldflags '-s -w -buildid=' ./cmd/indexd
sha256sum "$out"
