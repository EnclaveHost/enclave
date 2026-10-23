#!/bin/bash
# q.sh <mib> <name> <command...>: the unchanged shared queue; retries only on exit 98 (not started); logs/<name>.{queue.out,guard.log,rc}
set -u
mib="$1"; name="$2"; shift 2
L=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-code-admission-20261023/logs
cd /home/steven/Documents/Codex/2026-10-18/wo
for i in $(seq 1 240); do
  python3 work/claude-test-queue.py --mib "$mib" --log "$L/$name.guard.log" -- "$@" > "$L/$name.queue.out" 2>&1
  rc=$?; [ $rc -ne 98 ] && break; sleep 20
done
echo "$rc" > "$L/$name.rc"; exit $rc
