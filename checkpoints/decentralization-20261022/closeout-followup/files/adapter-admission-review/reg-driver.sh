#!/usr/bin/env bash
# Sequential regression driver (immutable): one queue job at a time (256 MiB), retry only on 98 (NOT STARTED); rc file per batch.
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/adapter-admission-review
for b in reg-b-*; do
  L=logs/rreg3-${b#reg-b-}
  for i in $(seq 1 60); do python3 ../../claude-test-queue.py --mib 256 --log $L.guard.log -- ./job-tests.sh $(cat $b) > $L.out 2>&1; rc=$?; [ $rc -ne 98 ] && break; sleep 30; done
  echo $rc > $L.rc
done
echo done > logs/rreg3.done
