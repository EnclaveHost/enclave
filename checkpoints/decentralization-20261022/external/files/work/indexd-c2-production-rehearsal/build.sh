#!/bin/bash
# Builds the rehearsal helpers (static, offline) inside ONE shared-queue allocation (512 MiB):
#   python3 ../claude-test-queue.py --mib 512 --log logs/build.guard.log -- ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
export CGO_ENABLED=0 GOPROXY=off GOFLAGS=-mod=mod GOMEMLIMIT=400MiB GOMAXPROCS=2
(cd tool28 && go vet . && taskset -c 0-1 go build -p 1 -trimpath -o ../bin/c2tool .)
(cd client && go vet . && taskset -c 0-1 go build -p 1 -trimpath -o ../bin/c2rclient .)
sha256sum bin/c2tool bin/c2rclient
