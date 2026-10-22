#!/bin/bash
# qrun.sh NAME MIB CMD... : run CMD (cwd = the candidate tree) through work/claude-test-queue.py at the prescribed cap,
# retrying ONLY while the queue answers 98 (not started). Writes logs/NAME.log (the job's own output), logs/NAME.guard
# (the queue's memory-guard line) and, last, logs/NAME.rc (the job's exit code). One job at a time per worker.
set -uo pipefail
C=/home/steven/Documents/Codex/2026-10-18/wo/work/platform-api-activation-closeout
name=$1; mib=$2; shift 2
rm -f "$C/logs/$name.rc" "$C/logs/$name.log" "$C/logs/$name.guard"
tries=0
while :; do
  tries=$((tries + 1))
  (cd "$C" && python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib "$mib" --log "$C/logs/$name.guard" -- "$@") > "$C/logs/$name.log" 2>&1
  rc=$?
  if [ "$rc" != 98 ]; then break; fi
  [ "$tries" -ge 240 ] && break
  sleep 20
done
echo "$rc tries=$tries $(date -Is)" > "$C/logs/$name.rc"
