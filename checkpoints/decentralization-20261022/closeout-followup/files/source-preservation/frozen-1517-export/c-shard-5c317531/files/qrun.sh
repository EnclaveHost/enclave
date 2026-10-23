#!/bin/bash
# qrun.sh <label> <mib> <command...>: ONE shared-queue job (work/claude-test-queue.py), retried only while it is NOT
# STARTED (exit 98). Output in logs/<label>.out, the queue exit in logs/<label>.rc. Start it in the background and wait
# for the .rc file.
here=$(cd "$(dirname "$0")" && pwd)
label=$1 mib=$2; shift 2
Q=/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py
rm -f "$here/logs/$label.rc"
for n in $(seq 1 400); do
  python3 -u "$Q" --mib "$mib" --log "$here/logs/$label.guard.log" -- "$@" > "$here/logs/$label.out" 2>&1
  c=$?
  [ $c != 98 ] && break
  sleep 20
done
echo "exit $c" > "$here/logs/$label.rc"
