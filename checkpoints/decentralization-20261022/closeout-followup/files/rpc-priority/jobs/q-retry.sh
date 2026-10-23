#!/bin/bash
# usage: q-retry.sh <mib> <name> <script>   (retries exit 98 = not started; writes <name>.rc)
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo
J=work/resume-after-checkpoint-20261022/rpc-priority/jobs
for i in $(seq 1 120); do
  python3 -u work/claude-test-queue.py --mib "$1" --log $J/$2.guard.log -- "$3" >> $J/$2.out 2>&1
  rc=$?
  [ $rc -ne 98 ] && { echo $rc > $J/$2.rc; exit 0; }
  sleep 60
done
echo 98 > $J/$2.rc
