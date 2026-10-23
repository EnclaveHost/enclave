#!/bin/bash
# q.sh NAME MIB -- command...   retry the shared queue while it answers 98 (not started); write logs/NAME.rc at the end
name=$1; mib=$2; shift 3
cd "$(dirname "$0")/.." || exit 2
for i in $(seq 1 240); do
  python3 -u ../claude-test-queue.py --mib "$mib" --log logs/$name.guard.log -- "$@" > logs/$name.out 2>&1
  rc=$?; [ $rc -ne 98 ] && break; sleep 30
done
echo $rc > logs/$name.rc
