#!/bin/bash
# q.sh <label> [mib]: ONE queue job running test/run-tests.sh (256 default, never above 512), retried only while NOT STARTED (98).
here=$(cd "$(dirname "$0")" && pwd); label=$1; mib=${2:-256}
case $mib in 256|512) ;; *) echo "cap must be 256 or 512" >&2; exit 2;; esac
Q=/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py
rm -f "$here/logs/$label.rc"
for n in $(seq 1 120); do
  python3 -u "$Q" --mib "$mib" --log "$here/logs/$label.guard.log" -- "$here/test/run-tests.sh" > "$here/logs/$label.out" 2>&1; c=$?
  [ $c != 98 ] && break; sleep 30
done
echo "exit $c" > "$here/logs/$label.rc"
