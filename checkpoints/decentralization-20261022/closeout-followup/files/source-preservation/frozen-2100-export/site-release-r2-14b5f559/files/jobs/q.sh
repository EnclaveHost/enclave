#!/bin/bash
# usage: q.sh <mib> <name> <command...>: retries the queue on exit 98 (not started), writes logs/<name>.rc
set -u
mib="$1"; name="$2"; shift 2
cd /home/steven/Documents/Codex/2026-10-18/wo
L=work/custody-v2-site-release-r2-20261023/logs
for i in $(seq 1 240); do
  python3 work/claude-test-queue.py --mib "$mib" --log "$L/$name.guard.log" -- "$@" > "$L/$name.queue.out" 2>&1
  rc=$?
  [ $rc -ne 98 ] && break
  sleep 30
done
echo $rc > "$L/$name.rc"
