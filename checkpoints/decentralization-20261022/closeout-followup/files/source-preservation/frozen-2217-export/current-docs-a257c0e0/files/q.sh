#!/bin/bash
# q.sh MIB NAME CMD...: the unchanged shared queue; retries only on exit 98 (NOT STARTED, kept as NAME.tryN.out); logs/NAME.{out,guard.log,rc}
mib=$1; name=$2; shift 2
L=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-current-docs-20261023/logs
[ ! -e "$L/$name.rc" ] || { echo "$name.rc exists"; exit 2; }
for i in $(seq 2 400); do
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib "$mib" --log "$L/$name.guard.log" -- "$@" > "$L/$name.out" 2>&1
  rc=$?; [ $rc -ne 98 ] && break; mv "$L/$name.out" "$L/$name.try$i.out"; sleep 10
done
echo $rc > "$L/$name.rc"; exit $rc
