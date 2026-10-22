#!/usr/bin/env bash
# q.sh <MiB> <log-name> <command...>: one job through the coordinator's shared queue (work/claude-test-queue.py), retried
# only while the queue answers 98 (NOT STARTED), at most 8 tries. Output goes to logs/<log-name>.log, the guard's
# summary to logs/<log-name>.guard.log. Prints the queue lines, the test summary and the final exit.
mib="$1"; name="$2"; shift 2
here="$(cd "$(dirname "$0")" && pwd)"; log="$here/logs/$name.log"; : > "$log"
for i in 1 2 3 4 5 6 7 8; do
  echo "[q] $(date -Is) try $i cmd: $*" >> "$log"
  python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib "$mib" --log "$here/logs/$name.guard.log" -- "$@" >> "$log" 2>&1
  rc=$?; [ $rc -ne 98 ] && break
done
echo "[q] $(date -Is) exit=$rc" >> "$log"
grep -E "^\[queue\] (START|EXIT)|^# (tests|pass|fail) |^not ok " "$log" | tail -12
echo "exit=$rc"; exit $rc
