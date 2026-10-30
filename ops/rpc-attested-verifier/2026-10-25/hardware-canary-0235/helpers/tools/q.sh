#!/bin/bash
# q.sh MIB NAME CMD... : run CMD through the shared queue (foreground); retry while exit 98 (not started), sleep 30.
# stdout/stderr -> rawlogs/NAME.out, guard line -> rawlogs/NAME.guard.log, final rc -> rawlogs/NAME.rc
mib=$1; name=$2; shift 2
d=$(cd "$(dirname "$0")/.." && pwd)/rawlogs
for i in $(seq 1 120); do
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib "$mib" --log "$d/$name.guard.log" -- "$@" >"$d/$name.out" 2>&1
  rc=$?
  [ $rc -ne 98 ] && break
  echo "[q.sh] try $i: 98 not started $(date -u +%FT%TZ)" >>"$d/$name.retries"; sleep 30
done
echo $rc >"$d/$name.rc"; exit $rc
