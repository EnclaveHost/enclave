#!/bin/bash
# Run the real-indexd harness and the sia-s3 driver in ONE bounded scope, then drop only this run's databases.
#
# Needs a PostgreSQL server on loopback that the coordinator has approved (COORDINATOR-REQUEST-postgres.txt), with
# a disposable role allowed to CREATE DATABASE. Nothing here starts, installs or reaches any other service.
#
#   PGPORT=55432 PGENV=<0600 KEY=VALUE file with POSTGRES_USER/POSTGRES_PASSWORD> ./run-real.sh <run-id>
#   stock indexd v0.6.0 (feed listing, as the main tree):  HARNESS=harness    SIAS3_REAL_INDEXD=v060 (default)
#   U1-patched indexd (current listing, the U1 fix):         HARNESS=harness-u1 SIAS3_REAL_INDEXD=u1
# (the coordinator's fixture: postgres-fixture.env; the harness reads it itself and never prints it)
#
# Evidence: runs/<run-id>/{events.jsonl,harness.log,driver.log,resources.txt}, hosts' sector files under
# runs/<run-id>/hosts (removed at the end, sizes recorded first).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
run=${1:?run id}
[[ "$run" =~ ^[a-z0-9]+$ ]] || { echo "run id: lowercase letters and digits only"; exit 2; }
: "${PGPORT:?}" "${PGENV:?}"
dir=$here/runs/$run
[ ! -e "$dir" ] || { echo "$dir exists"; exit 2; }
avail=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
[ "$avail" -ge $((18 * 1024 * 1024)) ] || { echo "MemAvailable ${avail} kB is below the 18 GiB start floor"; exit 3; }

# harness + driver share ONE scope of 1024 MiB (the Rust/indexd cap). The SDK's smallest layout real indexd accepts
# is 3-of-12 (slabs.ValidateECParams: redundancy <= 4, 99.99 % recovery at p = 0.75), so every replica of a PUT
# buffers 12 x 4 MiB; a 3-replica PUT took the driver to 404 MB anon and the earlier 640 MiB scope was OOM-killed.
exec "$here/logs/run-bounded.sh" "real-$run" bash -c '
  set -u
  here=$1 dir=$2 run=$3
  GOMEMLIMIT=256MiB GOMAXPROCS=2 taskset -c 0-1 "$here/bin/${HARNESS:-harness}" -dir "$dir" -indexd "$here/../indexd" -run "$run" -indexers 3 -hosts 14 \
     -pg-host 127.0.0.1 -pg-port "$PGPORT" -pg-env "$PGENV" &
  h=$!
  for _ in $(seq 1 600); do [ -f "$dir/ctl.url" ] && break; kill -0 $h 2>/dev/null || break; sleep 1; done
  if [ ! -f "$dir/ctl.url" ]; then echo "harness did not become ready"; wait $h; exit 1; fi
  ctl=$(cat "$dir/ctl.url")
  # RSS of the harness and the driver every 2 s (kB), for the resource report
  ( while kill -0 $h 2>/dev/null; do
      echo "$(date +%s) $(ps -o rss= -p $h 2>/dev/null | tr -d " ") $(pgrep -x sias3-real-driv | head -1 | xargs -r ps -o rss= -p 2>/dev/null | tr -d " ")" >> "$dir/rss.log"
      sleep 2
    done ) &
  SIAS3_REAL_CTL=$ctl SIAS3_REAL_INDEXD=${SIAS3_REAL_INDEXD:-v060} "$here/bin/sias3-real-driver" "${DRIVER_FILTER:-real_}" --ignored --test-threads=1 --nocapture > "$dir/driver.log" 2>&1
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
