#!/bin/bash
# Bounded retry: re-submit ONLY on queue exit 98 (not started); max 20 attempts, 30 s apart. New log name per attempt.
cd "$(dirname "$0")"
test -d tmp || exit 2
for i in $(seq 1 20); do
  T=$(date -u +%Y%m%dT%H%M%SZ)
  python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log "$PWD/logs/test-$T.guard" -- unshare -rn "$PWD/jobs.sh" > "logs/test-$T.out" 2>&1
  rc=$?; echo $rc > "logs/test-$T.rc"; echo "attempt $i $T rc=$rc"
  [ $rc -ne 98 ] && exit $rc
  sleep 30
done
exit 98
