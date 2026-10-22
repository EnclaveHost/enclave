#!/bin/bash
# One real-indexd case of the SDK worker's FROZEN driver (sdk-snapshot-final, FINAL-tree.sha256 323d3038...) against
# the indexd-fence RELEASE source tree (work/indexd-replica-rollout/src; harness built with go.release.mod), with the
# SDK worker's harness-block-object.patch applied to a COPY of the U1 harness (cmd/harness-block; cmd/harness kept).
# One shared-queue allocation (SDK job: 1024 MiB, 16 GiB reserve, no swap). Exit 98 = not started.
#   ./run-sdk-case.sh <run-id> <exact-test-name-or-filter> [more filters]
#   env: SIAS3_REAL_INDEXD (default fence), EXACT=1 (default) adds --exact, HARNESS_GOMEMLIMIT (default 160MiB)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
run=${1:?run id}; shift
[[ "$run" =~ ^[a-z0-9]+$ ]] || { echo "run id: lowercase letters and digits only"; exit 2; }
dir=$here/runs/$run
[ ! -e "$dir" ] || { echo "$dir exists"; exit 2; }
exec python3 "$here/../claude-test-queue.py" --mib 1024 --log "$here/logs/case-$run.guard.log" -- bash -c '
  set -u
  here=$1 dir=$2 run=$3; shift 3
  GOMEMLIMIT=${HARNESS_GOMEMLIMIT:-160MiB} GOMAXPROCS=2 taskset -c 0-1 "$here/bin/harness-block" -dir "$dir" -indexd "$here/../indexd-replica-rollout/src" -run "$run" -indexers 3 -hosts 12 \
     -pg-host 127.0.0.1 -pg-port 55432 -pg-env "$here/postgres-fixture.env" &
  h=$!
  for _ in $(seq 1 600); do [ -f "$dir/ctl.url" ] && break; kill -0 $h 2>/dev/null || break; sleep 1; done
  if [ ! -f "$dir/ctl.url" ]; then echo "harness did not become ready"; wait $h; exit 1; fi
  ctl=$(cat "$dir/ctl.url"); hp=${ctl#http://}
  post() { exec 3<>/dev/tcp/${hp%:*}/${hp#*:}; printf "POST %s HTTP/1.1\r\nHost: %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" "$1" "$hp" >&3; cat <&3; exec 3<&-; }
  ex=""; [ "${EXACT:-1}" = 1 ] && ex=--exact
  SIAS3_REAL_CTL=$ctl SIAS3_REAL_INDEXD=${SIAS3_REAL_INDEXD:-fence} taskset -c 2-3 "$here/bin/${DRIVER_BIN:-sdk-final-driver}" "$@" --ignored $ex --test-threads=1 --nocapture > "$dir/driver.log" 2>&1
  rc=$?
  post /evidence | sed -n "/^{/,\$p" > "$dir/evidence.json" || true
  du -sb "$dir/hosts" > "$dir/resources.txt" 2>&1 || true
  post "/exit?drop=1" >/dev/null || true
  wait $h || true
  rm -rf "$dir/hosts"
  sed -E -i "s/(sc|ss|sf)=[A-Za-z0-9%_=-]+/\1=<redacted>/g" "$dir/driver.log" "$dir/events.jsonl"
  grep -E "^test |test result|panicked" "$dir/driver.log" || true
  exit $rc
' _ "$here" "$dir" "$run" "$@"
