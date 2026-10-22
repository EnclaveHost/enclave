#!/bin/bash
# usage: fence-gotest.sh <pkg> [go test args...]   Loads the fixture credentials privately (never printed) and points
# the indexd persist tests at this worker's own disposable database on the fixture.
set -a; . /home/steven/Documents/Codex/2026-10-18/wo/work/storage-real-indexd/postgres-fixture.env; set +a
export POSTGRES_DB=sias3_real_fence_t POSTGRES_PORT=55432 POSTGRES_DB_PREFIX=sias3_real_fence_
cd "${FENCE_TREE:-/home/steven/Documents/Codex/2026-10-18/wo/work/storage-real-indexd/indexd-fence}"
# taskset: runtime.NumCPU follows the affinity mask, so pgxpool's default MaxConns (max(4, NumCPU)) stays at 4 per pool:
# the fixture allows 30 connections (3 reserved, ~8 used by the server itself)
exec taskset -c 0-3 env GOPROXY=off GOFLAGS=-mod=mod GOMAXPROCS=2 go test -p 1 "$@"
