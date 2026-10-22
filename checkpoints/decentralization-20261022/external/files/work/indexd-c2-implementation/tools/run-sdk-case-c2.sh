#!/bin/bash
# G-C2: one real-indexd case of an SDK driver (DRIVER, absolute path) against the G-C2 source (work/indexd-c2-implementation/src;
# harness built with go.c2.mod from a byte-identical copy of storage-real-indexd/harness). Derived from storage-real-indexd/run-sdk-case.sh.
# One shared-queue allocation (QUEUE_MIB, default 768 = real interop; 16 GiB floor, no swap). Exit 98 = not started.
#   DRIVER=/abs/driver ./tools/run-sdk-case-c2.sh <run-id> <exact-test-name-or-filter> [more filters]
#   env: HARNESS (default bin/harness-c2), INDEXD_SRC (default src), SIAS3_REAL_INDEXD (default fence), EXACT=1 (default) adds --exact, HARNESS_GOMEMLIMIT (default 160MiB)
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
run=${1:?run id}; shift
[[ "$run" =~ ^[a-z0-9]+$ ]] || { echo "run id: lowercase letters and digits only"; exit 2; }
dir=$here/runs/$run
[ ! -e "$dir" ] || { echo "$dir exists"; exit 2; }
exec python3 "$here/../claude-test-queue.py" --mib ${QUEUE_MIB:-768} --log "$here/logs/case-$run.guard.log" -- bash -c '
  set -u
  here=$1 dir=$2 run=$3; shift 3
  GOMEMLIMIT=${HARNESS_GOMEMLIMIT:-160MiB} GOMAXPROCS=2 taskset -c 0-1 "${HARNESS:-$here/bin/harness-c2}" -dir "$dir" -indexd "${INDEXD_SRC:-$here/src}" -run "$run" -indexers 3 -hosts 12 \
     -pg-host 127.0.0.1 -pg-port 55432 -pg-env "$here/../storage-real-indexd/postgres-fixture.env" &
  h=$!
  for _ in $(seq 1 600); do [ -f "$dir/ctl.url" ] && break; kill -0 $h 2>/dev/null || break; sleep 1; done
  if [ ! -f "$dir/ctl.url" ]; then echo "harness did not become ready"; wait $h; exit 1; fi
  ctl=$(cat "$dir/ctl.url"); hp=${ctl#http://}
  post() { exec 3<>/dev/tcp/${hp%:*}/${hp#*:}; printf "POST %s HTTP/1.1\r\nHost: %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" "$1" "$hp" >&3; cat <&3; exec 3<&-; }
  ex=""; [ "${EXACT:-1}" = 1 ] && ex=--exact
  SIAS3_REAL_CTL=$ctl SIAS3_REAL_INDEXD=${SIAS3_REAL_INDEXD:-fence} taskset -c 2-3 "${DRIVER:?absolute driver path}" "$@" --ignored $ex --test-threads=1 --nocapture > "$dir/driver.log" 2>&1
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
