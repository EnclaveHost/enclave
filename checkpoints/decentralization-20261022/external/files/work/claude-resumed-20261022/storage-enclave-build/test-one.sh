#!/bin/bash
# storage-enclave-build A1 step 4: `go test ./contracts/... ./cmd/...` on ONE exact assembled tree, through the queue (1024).
#   test-one.sh <fence-enclave|c2-enclave>
# - No network: a new user+network namespace (unshare -rn) with only loopback up, so geoip downloads or other dials fail
#   instead of leaving the host.
# - No PostgreSQL is started or reachable: every POSTGRES_* variable is unset, and 127.0.0.1:5432 has no listener in the
#   namespace. Tests that open testutils.NewDB therefore fail at connect; classify-tests.py separates those failures.
# - -mod=readonly, GOPROXY=off, GOTOOLCHAIN=local, -p 1, GOMAXPROCS=2, 2 CPUs, a new empty GOCACHE.
# - The tree inventory must be identical before and after.
set -euo pipefail
B=$(cd "$(dirname "$0")" && pwd); n=$1; t=$B/trees/$n; inv=$B/inventory/$n.sha256
(cd "$t" && sha256sum -c --quiet "$inv") && echo "$n inventory unchanged before tests"
cache=$B/gocache/test-$n; [ ! -e "$cache" ] || { echo "refusing: $cache exists"; exit 1; }; mkdir -p "$cache"
json=$B/logs/test-$n.json; : > "$json"
set +e
env -u POSTGRES_USER -u POSTGRES_PASSWORD -u POSTGRES_DB -u POSTGRES_PORT -u POSTGRES_DB_PREFIX \
  GOCACHE="$cache" GOTOOLCHAIN=local GOPROXY=off GOFLAGS=-mod=readonly GOMAXPROCS=2 GOMEMLIMIT=600MiB CGO_ENABLED=0 \
  unshare -rn sh -c 'ip link set lo up && cd "$1" && exec taskset -c 0-1 go test -p 1 -count=1 -json -timeout 15m ./contracts/... ./cmd/...' _ "$t" > "$json"
rc=$?; set -e
echo "go test exit: $rc"
(cd "$t" && sha256sum -c --quiet "$inv") && [ "$(find "$t" -type f | wc -l)" = "$(wc -l < "$inv")" ] && echo "$n inventory unchanged after tests"
rm -rf "$cache"
python3 "$B/classify-tests.py" "$json"
