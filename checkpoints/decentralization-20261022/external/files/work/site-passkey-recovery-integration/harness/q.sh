#!/usr/bin/env bash
# q.sh MIB NAME WINDOW_SEC -- command...   : the shared queue, retried while it answers 98 (not started); output in logs/NAME.log
mib="$1" name="$2" win="$3"; shift 4
C="$(cd "$(dirname "$0")/.." && pwd)"; t0=$(date +%s)
while :; do
  python3 "$C/../claude-test-queue.py" --mib "$mib" --log "$C/logs/$name.guard.log" -- "$@" > "$C/logs/$name.log" 2>&1; rc=$?
  [ $rc -ne 98 ] && break
  [ $(( $(date +%s) - t0 )) -gt "$win" ] && break
  sleep 7
done
echo "QUEUE-DONE $name EXIT=$rc" | tee -a "$C/logs/$name.status"
