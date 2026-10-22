#!/bin/bash
# Control: TestContractFunding on a pristine COPY of the tested stock fence source (indexd-replica-rollout/src, no enclave-small),
# and on the assembled fence-enclave tree. Same isolation as test-one.sh (no network, no PostgreSQL; this test needs neither).
set -euo pipefail
B=$(cd "$(dirname "$0")" && pwd); W=$(cd "$B/../.." && pwd); c=$B/control/fence-stock-src
[ ! -e "$c" ] || { echo "refusing: $c exists"; exit 1; }
mkdir -p "$B/control"; cp -a "$W/indexd-replica-rollout/src" "$c"
(cd "$c" && sha256sum -c --quiet "$W/indexd-c2-implementation/BASE-src.sha256") && echo "stock copy matches BASE-src.sha256 7c5cf425"
grep -n "minContractGrowthRate = " "$c/contracts/form.go"
for t in "$c" "$B/trees/fence-enclave"; do
  cache=$(mktemp -d "$B/control/.cache.XXXX")
  set +e
  env -u POSTGRES_USER -u POSTGRES_PASSWORD -u POSTGRES_DB -u POSTGRES_PORT -u POSTGRES_DB_PREFIX GOCACHE="$cache" GOTOOLCHAIN=local GOPROXY=off \
    GOFLAGS=-mod=readonly GOMAXPROCS=2 GOMEMLIMIT=600MiB CGO_ENABLED=0 \
    unshare -rn sh -c 'ip link set lo up && cd "$1" && exec taskset -c 0-1 go test -p 1 -count=1 -v -run "^TestContractFunding$" ./contracts/' _ "$t" | grep -E "^(--- |ok|FAIL|PASS)|form_test"
  echo "exit $? for $t"; set -e
  rm -rf "$cache"
done
rm -rf "$c"
