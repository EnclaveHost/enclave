#!/bin/bash
# Usage: frozen-0318-q.sh <name> <script> ; retries the 256 MiB small lane (exit 98 = not started), writes <name>.rc
cd "$(dirname "$0")"
n=$1; shift
for i in $(seq 1 120); do
  python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log "$n.guard.log" -- "$@" > "$n.out" 2>&1
  rc=$?
  [ $rc -ne 98 ] && break
  sleep 30
done
echo $rc > "$n.rc"
