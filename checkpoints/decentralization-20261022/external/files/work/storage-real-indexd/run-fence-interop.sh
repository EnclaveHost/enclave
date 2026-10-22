#!/bin/bash
# SDK+Go interop gate: the SDK worker's UNEDITED real-indexd fencing driver (sdk-snapshot, src/real_fencing.rs, the
# real_fence_ cases) against indexd-fence through the U1 harness source built with go.fence.mod (bin/harness-fence).
# One bounded allocation of the shared queue (768 MiB, 16 GiB floor). Databases dropped, host sectors removed.
#   ./run-fence-interop.sh <run-id>      (fixture credentials are read by the harness from postgres-fixture.env)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
run=${1:?run id}
[[ "$run" =~ ^[a-z0-9]+$ ]] || { echo "run id: lowercase letters and digits only"; exit 2; }
dir=$here/runs/$run
[ ! -e "$dir" ] || { echo "$dir exists"; exit 2; }
# shared queue (work/claude-test-queue.py): 768 MiB cap (this stream's approved cap), 16 GiB floor, exit 98 = not started
exec python3 "$here/../claude-test-queue.py" --mib 768 --log "$here/logs/interop-$run.guard.log" -- bash -c '
  set -u
  here=$1 dir=$2 run=$3
  GOMEMLIMIT=${HARNESS_GOMEMLIMIT:-256MiB} GOMAXPROCS=2 taskset -c 0-1 "$here/bin/harness-fence" -dir "$dir" -indexd "$here/indexd-fence" -run "$run" -indexers 3 -hosts 12 \
     -pg-host 127.0.0.1 -pg-port 55432 -pg-env "$here/postgres-fixture.env" &
  h=$!
  for _ in $(seq 1 600); do [ -f "$dir/ctl.url" ] && break; kill -0 $h 2>/dev/null || break; sleep 1; done
  if [ ! -f "$dir/ctl.url" ]; then echo "harness did not become ready"; wait $h; exit 1; fi
  ctl=$(cat "$dir/ctl.url")
  SIAS3_REAL_CTL=$ctl SIAS3_REAL_INDEXD=${SIAS3_REAL_INDEXD:-fence} taskset -c 2-3 "$here/bin/${DRIVER_BIN:-sdk-snapshot-driver}" ${DRIVER_FILTER:-real_fence_} --ignored --test-threads=1 --nocapture > "$dir/driver.log" 2>&1
  rc=$?
  du -sb "$dir/hosts" > "$dir/resources.txt" 2>&1 || true
  hp=${ctl#http://}
  exec 3<>/dev/tcp/${hp%:*}/${hp#*:}
  printf "POST /exit?drop=1 HTTP/1.1\r\nHost: %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" "$hp" >&3
  cat <&3 >/dev/null || true
  wait $h || true
  rm -rf "$dir/hosts"
  grep -E "^test |test result|EVIDENCE" "$dir/driver.log" || true
  exit $rc
' _ "$here" "$dir" "$run"
