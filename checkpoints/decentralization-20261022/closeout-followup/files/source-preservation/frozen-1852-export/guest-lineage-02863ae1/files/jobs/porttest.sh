#!/bin/bash
set -uo pipefail
D=/home/steven/Documents/Codex/2026-10-18/wo/work/resource-guest-lineage-20261023
export GOTOOLCHAIN=local GOPROXY=off GOFLAGS=-mod=mod GOCACHE=$D/scratch/gocache GOMAXPROCS=2 GOMEMLIMIT=512MiB CGO_ENABLED=0
for t in rw port; do
  echo "=== $t: go vet + go test ./monitor ./secretrun (isolation/m3)"
  (cd $D/scratch/$t/isolation/m3 && gofmt -l monitor secretrun; go vet ./monitor && go test -count=1 ./monitor ./secretrun 2>&1 | tail -15); echo "rc=$?"
done
echo "=== port: focused CPU tests verbose"
(cd $D/scratch/port/isolation/m3 && go test -count=1 -run 'CPU|Allowance|Allocated' -v ./monitor 2>&1 | grep -E "^(=== RUN|--- |ok|FAIL|PASS)" | head -40)
