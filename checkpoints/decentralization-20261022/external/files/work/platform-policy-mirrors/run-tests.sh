#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo
rc=98
for attempt in $(seq 1 30); do
  set +e
  python3 work/claude-test-queue.py --mib 256 --log /home/steven/Documents/Codex/2026-10-18/wo/work/platform-policy-mirrors/logs/final.guard.log -- python3 -m unittest discover -s work/platform-policy-mirrors -p 'test_*.py' -v > work/platform-policy-mirrors/logs/final.out 2>&1
  rc=$?
  set -e
  if [ "$rc" -ne 98 ]; then break; fi
  sleep 15
done
printf '%s\n' "$rc" > work/platform-policy-mirrors/logs/final.done
exit "$rc"
