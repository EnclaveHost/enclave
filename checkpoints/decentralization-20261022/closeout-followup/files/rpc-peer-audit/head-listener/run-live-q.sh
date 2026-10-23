#!/bin/bash
cd "$(dirname "$0")"
for i in $(seq 1 60); do
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log runs/live.guard.log ./live.sh > runs/live.out 2>&1
  rc=$?; [ $rc -ne 98 ] && break; sleep 30
done
echo $rc > runs/live.rc
