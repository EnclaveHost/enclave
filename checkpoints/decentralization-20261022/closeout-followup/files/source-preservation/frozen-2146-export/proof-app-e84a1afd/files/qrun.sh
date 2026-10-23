#!/bin/bash
# qrun.sh <label> <mib> <command...>: ONE queue job, retried only while NOT STARTED (98). logs/<label>.out, logs/<label>.rc
here=$(cd "$(dirname "$0")" && pwd); label=$1 mib=$2; shift 2
Q=/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py
rm -f "$here/logs/$label.rc"
for n in $(seq 1 300); do
  python3 -u "$Q" --mib "$mib" --log "$here/logs/$label.guard.log" -- "$@" > "$here/logs/$label.out" 2>&1; c=$?
  [ $c != 98 ] && break; sleep 20
done
echo "exit $c" > "$here/logs/$label.rc"
