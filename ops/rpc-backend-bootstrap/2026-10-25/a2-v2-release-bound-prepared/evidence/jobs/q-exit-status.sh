#!/bin/bash
# q.sh NAME MIB CMD... : retry the shared queue on exit 98 (not started); writes logs/NAME.out and logs/NAME.rc
N=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
name=$1 mib=$2; shift 2
for i in $(seq 1 240); do
  python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib $mib --log $N/logs/$name.guard -- "$@" >>$N/logs/$name.out 2>&1
  rc=$?; [ $rc -ne 98 ] && break; echo "[q.sh] try $i not started; sleep 30" >>$N/logs/$name.out; sleep 30
done
echo $rc > $N/logs/$name.rc
exit "$rc"
