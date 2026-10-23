#!/bin/bash
# q.sh MIB NAME CMD... : run CMD through the shared queue (foreground) inside a private user+network namespace (loopback only);
# retry while exit 98 (not started), sleep 30. stdout/stderr -> rawlogs/NAME.out, guard line -> rawlogs/NAME.guard.log,
# final rc -> rawlogs/NAME.rc. Refuses to reuse a NAME (unique logs).
mib=$1; name=$2; shift 2
d=$(cd "$(dirname "$0")/.." && pwd)/rawlogs
[ ! -e "$d/$name.rc" ] && [ ! -e "$d/$name.out" ] || { echo "rawlogs/$name exists"; exit 2; }
for i in $(seq 1 120); do
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib "$mib" --log "$d/$name.guard.log" -- \
    unshare -r -n -- bash -c 'ip link set lo up && exec "$@"' q "$@" >"$d/$name.out" 2>&1
  rc=$?
  [ $rc -ne 98 ] && break
  echo "[q.sh] try $i: 98 not started $(date -u +%FT%TZ)" >>"$d/$name.retries"; mv "$d/$name.out" "$d/$name.try$i.out"; sleep 30
done
echo $rc >"$d/$name.rc"; exit $rc
