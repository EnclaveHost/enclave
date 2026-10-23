#!/bin/bash
# frozen-2100-q.sh MIB NAME CMD... : run CMD through the shared queue, retrying only while it exits 98 (NOT STARTED);
# every not-started attempt's output is KEPT as NAME.tryN.out; final output NAME.out, guard NAME.guard.log, rc NAME.rc.
mib=$1; name=$2; shift 2
d=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/source-preservation
[ ! -e "$d/$name.rc" ] || { echo "$name.rc exists"; exit 2; }
for i in $(seq 2 400); do
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib "$mib" --log "$d/$name.guard.log" -- "$@" > "$d/$name.out" 2>&1
  rc=$?; [ $rc -ne 98 ] && break
  mv "$d/$name.out" "$d/$name.try$i.out"; sleep 10
done
echo $rc > "$d/$name.rc"; exit $rc
