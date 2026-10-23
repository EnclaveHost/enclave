#!/bin/bash
# usage: q.sh <mib> <name> <script>  (the shared queue; retries exit 98 = not started; writes <name>.rc beside the job)
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo
J=work/credit-vault-submitter-verifier-20261023/jobs
for i in $(seq 1 240); do
  python3 -u work/claude-test-queue.py --mib "$1" --log $J/$2.guard.log -- "$3" >> $J/$2.out 2>&1
  rc=$?
  [ $rc -ne 98 ] && { echo $rc > $J/$2.rc; exit 0; }
  sleep 60
done
echo 98 > $J/$2.rc
