#!/bin/bash
# run.sh <run-id> <smoke|full> [mib]: one shared-queue allocation (default 1024 MiB; 16 GiB floor, no swap), retried
# only while the queue answers 98 (NOT STARTED); every other exit is the run's own terminal status.
cd "$(dirname "$0")" || exit 2
id=$1 mode=$2 mib=${3:-1024}
mkdir -p logs
for i in $(seq 1 120); do
  python3 ../claude-test-queue.py --mib "$mib" --log "logs/$id.guard.log" -- python3 e2e.py "$id" "$mode" > "logs/$id.out" 2>&1
  rc=$?
  [ $rc -ne 98 ] && break
  echo "attempt $i: NOT STARTED (98)" >> "logs/$id.notstarted"
  sleep 2
done
echo "TERMINAL rc=$rc attempts=$i" >> "logs/$id.out"
