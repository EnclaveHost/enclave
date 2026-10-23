#!/bin/bash
# usage: q.sh <name> <mib> <script> [args...]  -> jobs/<name>.{out,guard.log,rc}; retries only while NOT STARTED (exit 98)
cd "$(dirname "$0")"
n=$1 mib=$2; shift 2
for i in $(seq 1 60); do
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib $mib --log $n.guard.log "$@" > $n.out 2>&1
  rc=$?; [ $rc -ne 98 ] && break; sleep 30
done
echo $rc > $n.rc
