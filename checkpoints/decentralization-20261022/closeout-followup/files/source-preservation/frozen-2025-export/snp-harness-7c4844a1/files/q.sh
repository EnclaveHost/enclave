#!/bin/bash
# q.sh <label>: ONE 256 MiB queue job running tests/run-tests.sh, retried only while NOT STARTED (98).
here=$(cd "$(dirname "$0")" && pwd); label=$1
Q=/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py
rm -f "$here/logs/$label.rc"
for n in $(seq 1 120); do
  python3 -u "$Q" --mib 256 --log "$here/logs/$label.guard.log" -- "$here/tests/run-tests.sh" > "$here/logs/$label.out" 2>&1; c=$?
  [ $c != 98 ] && break; sleep 30
done
echo "exit $c" > "$here/logs/$label.rc"
