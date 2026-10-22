#!/bin/bash
# Focused funding tests: both corrected snapshots must PASS. Negative controls must FAIL: the same test patch on a stock
# (256 GiB) copy, and the pinned unpatched enclave tree. No network (unshare -rn), no PostgreSQL, -mod=readonly, offline.
set -uo pipefail
F=$(cd "$(dirname "$0")" && pwd); W=$(cd "$F/../.." && pwd); EB=$F/../storage-enclave-build
run() {  # run <label> <tree> <expect pass|fail>
  local out rc
  out=$(env -u POSTGRES_USER -u POSTGRES_PASSWORD -u POSTGRES_DB -u POSTGRES_PORT -u POSTGRES_DB_PREFIX GOCACHE="$CACHE" GOTOOLCHAIN=local GOPROXY=off \
        GOFLAGS=-mod=readonly GOMAXPROCS=2 GOMEMLIMIT=600MiB CGO_ENABLED=0 \
        unshare -rn sh -c 'ip link set lo up && cd "$1" && exec taskset -c 0-1 go test -p 1 -count=1 -v -run "^(TestContractFunding|TestContractFundingEnclaveSmall)$" ./contracts/' _ "$2" 2>&1); rc=$?
  echo "$out" | grep -E "^(=== RUN|--- |\s+--- |ok|FAIL|PASS)|form_test.go:[0-9]+:" | grep -v "^=== RUN"
  local got=pass; [ $rc -eq 0 ] || got=fail
  echo "RESULT $1: go test exit $rc ($got), expected $3 -> $([ $got = $3 ] && echo OK || echo UNEXPECTED)"
  [ $got = $3 ]
}
CACHE=$(mktemp -d "$F/.cache.XXXX"); trap 'rm -rf "$CACHE" "$F/control"' EXIT
status=0
for n in fence-enclave c2-enclave; do
  d=$( (cd "$F/snapshots/$n" && sha256sum -c "$EB/inventory/$n.sha256" 2>/dev/null) | grep -v ': OK$' | sed 's/: FAILED$//')
  [ "$d" = "./contracts/form_test.go" ] && [ "$(find "$F/snapshots/$n" -type f | wc -l)" = "$(wc -l < "$EB/inventory/$n.sha256")" ] \
    && echo "$n snapshot differs from the pinned tree only in contracts/form_test.go" || { echo "$n snapshot diff unexpected: $d"; status=1; }
  run "snapshot $n (patched test)" "$F/snapshots/$n" pass || status=1
done
mkdir -p "$F/control"; cp -a "$W/indexd-replica-rollout/src" "$F/control/stock"
(cd "$F/control/stock" && sha256sum -c --quiet "$W/indexd-c2-implementation/BASE-src.sha256") && echo "stock copy == BASE-src.sha256 7c5cf425"
(cd "$F/control/stock" && patch -p0 --quiet < "$F/patches/funding-test-enclave-small.patch") && echo "test patch applied to the stock copy"
run "NEGATIVE CONTROL stock 256 GiB + test patch" "$F/control/stock" fail || status=1
run "NEGATIVE CONTROL pinned enclave tree, unpatched test" "$EB/trees/fence-enclave" fail || status=1
(cd "$EB/trees/fence-enclave" && sha256sum -c --quiet "$EB/inventory/fence-enclave.sha256") && echo "pinned fence-enclave tree unchanged"
exit $status
