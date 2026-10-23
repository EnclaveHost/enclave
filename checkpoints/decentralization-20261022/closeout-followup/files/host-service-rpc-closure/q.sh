#!/bin/bash
# Usage: q.sh <mib> <name> <cmd...> ; retries exit 98 (not started), writes logs/<name>.{out,guard.log,rc}
cd "$(dirname "$0")"
mib=$1; n=$2; shift 2
for i in $(seq 1 120); do
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib "$mib" --log "logs/$n.guard.log" -- "$@" > "logs/$n.out" 2>&1
  rc=$?
  [ $rc -ne 98 ] && break
  sleep 30
done
echo $rc > "logs/$n.rc"
