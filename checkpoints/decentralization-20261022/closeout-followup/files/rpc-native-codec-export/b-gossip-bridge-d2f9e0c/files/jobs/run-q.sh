#!/bin/bash
# usage: jobs/run-q.sh <name>   (queue 768, retries while the lane is busy; writes jobs/<name>.{out,guard.log,rc})
cd "$(dirname "$0")/.."
n=$1
for i in $(seq 1 60); do
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 768 --log jobs/$n.guard.log ./jobs/bridge-tests.sh > jobs/$n.out 2>&1
  rc=$?; [ $rc -ne 98 ] && break; sleep 30
done
echo $rc > jobs/$n.rc
