#!/bin/bash
# Full `go test ./contracts/... ./cmd/...` on ONE corrected snapshot; same isolation as storage-enclave-build/test-one.sh
# (no network, no PostgreSQL, -mod=readonly, offline). Classified with the pinned storage-enclave-build/classify-tests.py.
set -euo pipefail
F=$(cd "$(dirname "$0")" && pwd); EB=$F/../storage-enclave-build; n=$1; t=$F/snapshots/$n
c=$(mktemp -d "$F/.cache.XXXX"); trap 'rm -rf "$c"' EXIT
json=$F/logs/full-$n.json
set +e
env -u POSTGRES_USER -u POSTGRES_PASSWORD -u POSTGRES_DB -u POSTGRES_PORT -u POSTGRES_DB_PREFIX GOCACHE="$c" GOTOOLCHAIN=local GOPROXY=off \
  GOFLAGS=-mod=readonly GOMAXPROCS=2 GOMEMLIMIT=600MiB CGO_ENABLED=0 \
  unshare -rn sh -c 'ip link set lo up && cd "$1" && exec taskset -c 0-1 go test -p 1 -count=1 -json -timeout 15m ./contracts/... ./cmd/...' _ "$t" > "$json"
echo "go test exit: $?"; set -e
python3 "$EB/classify-tests.py" "$json"
