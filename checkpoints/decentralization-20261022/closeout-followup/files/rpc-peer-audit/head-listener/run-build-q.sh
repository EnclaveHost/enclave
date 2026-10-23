#!/bin/bash
cd "$(dirname "$0")"
mkdir -p runs
n=$(date -u +%Y%m%dT%H%M%SZ)
for i in $(seq 1 60); do
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1536 --log runs/build-$n.guard.log ./build.sh >> runs/build-$n.out 2>&1
  rc=$?
  [ $rc -ne 98 ] && break
  sleep 30
done
echo "$n $rc" > runs/build.rc
