#!/usr/bin/env bash
# q.sh <name> <mib> -- cmd...   : run through the shared queue; retry while NOT STARTED (98); write logs/<name>.rc
set -uo pipefail
name=$1; mib=$2; shift 3
L=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/logs
for i in $(seq 1 120); do
  python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib "$mib" --log "$L/$name.guard.log" -- "$@" > "$L/$name.out" 2>&1
  rc=$?
  [ "$rc" -ne 98 ] && break
  sleep 30
done
echo "$rc" > "$L/$name.rc"
