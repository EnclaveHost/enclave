#!/usr/bin/env bash
# q.sh <MiB> <name> <command...>: ONE build/test job through the coordinator's queue (work/claude-test-queue.py), retried
# only while the queue answers 98 (NOT STARTED), at most 8 tries. stdout+stderr -> logs/<name>.log (fresh per call);
# the guard's summary line -> logs/<name>.guard.log. Prints the queue lines, the test summary and the exit.
set -u
mib="$1"; name="$2"; shift 2
here="$(cd "$(dirname "$0")" && pwd)"; log="$here/logs/$name.log"; : > "$log"
for i in 1 2 3 4 5 6 7 8; do
  echo "[q] $(date -Is) try $i cmd: $*" >> "$log"
  python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib "$mib" --log "$here/logs/$name.guard.log" -- "$@" >> "$log" 2>&1
  rc=$?; [ $rc -ne 98 ] && break
done
echo "[q] $(date -Is) exit=$rc" >> "$log"
grep -E "^\[queue\] (START|EXIT)|^(ok|FAIL|PASS|---) |^# (tests|pass|fail) |^not ok |^--- FAIL" "$log" | tail -20
echo "exit=$rc"; exit $rc
