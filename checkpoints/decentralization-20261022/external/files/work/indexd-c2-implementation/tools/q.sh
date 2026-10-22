#!/bin/bash
# q.sh <mib> <name> <command...>: one shared-queue job, retried while the queue answers 98 (not started); writes
# logs/<name>.out and logs/<name>.done (rc). Run detached; wait for the .done file.
mib=$1 name=$2; shift 2
cd "$(dirname "$0")/.." || exit 2
rm -f "logs/$name.done"
for i in $(seq 1 120); do
  python3 ../claude-test-queue.py --mib "$mib" --log "logs/$name.guard.log" -- "$@" > "logs/$name.out" 2>&1; rc=$?
  [ $rc -ne 98 ] && break; sleep 30
done
echo "rc=$rc try=$i" > "logs/$name.done"
exit $rc
