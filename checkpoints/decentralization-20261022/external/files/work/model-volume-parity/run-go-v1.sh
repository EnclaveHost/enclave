#!/usr/bin/env bash
# Model volumes, Go and C (immutable; v1): the init handoff (M1 block, measured table, disks by serial, staging,
# budgeted preloads; glibc + musl), the front (config volumes, M1 block, handoff) with its whole package, guestd's whole
# suite (table, store, health, create, attach list). All through the candidate tree.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export GOFLAGS="-mod=readonly -p=2" GOTOOLCHAIN=local GOMAXPROCS=4
cd "$here/tree/isolation/m2"
sh ./test-dominit-handoff.sh
go vet ./front/ && go vet -tags shielddirect,bootstrapdirect ./front/
go test -count=1 ./front/ ./egress/ ./appconfig/
cd "$here/tree/isolation/m4/guestd"
go vet ./...
go test -count=1 -run 'Model|Health|Create|Volume' ./...
echo "run-go-v1: PASS"
