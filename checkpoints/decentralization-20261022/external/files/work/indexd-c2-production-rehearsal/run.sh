#!/bin/bash
# run.sh <run-id>: ONE shared-queue job (768 MiB) entering a fresh user+network namespace (loopback only), retried
# while the queue answers 98 (nothing started). Writes logs/<run>.out, logs/<run>.done (rc) and results/<run>-results.json.
set -u
cd "$(dirname "$0")" || exit 2
run=${1:?run id}
rm -f "logs/$run.done"
for i in $(seq 1 120); do
  python3 ../claude-test-queue.py --mib 768 --log "logs/$run.guard.log" -- env RH_UID="$(id -u)" RH_GID="$(id -g)" RH_RUN="$run" \
    taskset -c 0-1 unshare --user --map-root-user --net -- sh -c 'ip link set lo up && exec python3 rehearse-c2.py' > "logs/$run.out" 2>&1
  rc=$?
  [ $rc -ne 98 ] && break
  echo "attempt $i: 98 (not started) $(date -u +%FT%TZ)" >> "logs/$run.attempts"
  sleep 30
done
echo "rc=$rc attempts=$i" > "logs/$run.done"
