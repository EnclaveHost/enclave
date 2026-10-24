#!/bin/bash
# q.sh MIB NAME CMD... : run CMD through the unchanged shared queue, retrying only on exit 98 (NOT STARTED); keeps every try.
mib=$1; name=$2; shift 2
d=$(cd "$(dirname "$0")" && pwd)/logs
[ ! -e "$d/$name.rc" ] || { echo "$name.rc exists"; exit 2; }
for i in $(seq 2 200); do
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib "$mib" --log "$d/$name.guard.log" -- "$@" > "$d/$name.out" 2>&1
  rc=$?; [ $rc -ne 98 ] && break
  mv "$d/$name.out" "$d/$name.try$i.out"; sleep 10
done
echo $rc > "$d/$name.rc"; exit $rc
