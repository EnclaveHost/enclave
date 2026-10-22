#!/bin/bash
# one 256 MiB queue job; retry 98 (not started) every 30 s; rc file written when terminal
cd /home/steven/Documents/Codex/2026-10-18/wo/work/ens-outage-20261022/batch-topup-review
TS=$(date -u +%Y%m%dT%H%M%SZ); rm -f tests.rc
for i in $(seq 1 60); do
  python3 -u ../../claude-test-queue.py --mib 256 --log "queue-batch-topup-$TS.log" -- node --test batch-topup.test.mjs > "tests-$TS.out" 2>&1
  rc=$?; [ $rc -ne 98 ] && break; sleep 30
done
echo "$rc $TS" > tests.rc
