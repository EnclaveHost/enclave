#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo
rc=98
for attempt in $(seq 1 30); do
  set +e
  python3 work/claude-test-queue.py --mib 512 --log /home/steven/Documents/Codex/2026-10-18/wo/work/cold-history-deadline-review/guard.log -- bash work/cold-history-deadline-review/test.sh > work/cold-history-deadline-review/run.log 2>&1
  rc=$?
  set -e
  if [ "$rc" -ne 98 ]; then break; fi
  sleep 15
done
printf '%s\n' "$rc" > work/cold-history-deadline-review/done
exit "$rc"
