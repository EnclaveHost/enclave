#!/bin/bash
# usage: jobs/run-q.sh <name>  -> queue 1536 (Rust build), writes jobs/<name>.{out,guard.log,rc}
cd "$(dirname "$0")/.."
n=$1
for i in $(seq 1 60); do
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1536 --log jobs/$n.guard.log ./build-commitment.sh > jobs/$n.out 2>&1
  rc=$?; [ $rc -ne 98 ] && break; sleep 30
done
echo $rc > jobs/$n.rc
