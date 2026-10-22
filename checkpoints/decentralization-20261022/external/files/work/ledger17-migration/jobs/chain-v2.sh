#!/bin/sh
# Serial plan-v2 chain through the coordinator's queue. Each step retries ONLY while the queue reports "not started"
# (exit 98); any started step's own exit code is final. One allocation at a time; nothing runs outside the queue.
cd "$(dirname "$0")/.." || exit 2
Q=../claude-test-queue.py; LOG=jobs/chain-v2.log; MIGRATOR=0x120ba39e91395273496c4c7d065733c9db461dbb
step() { name=$1; mib=$2; shift 2; n=0
  while :; do n=$((n+1)); echo "[$(date -u +%H:%M:%S)] $name attempt $n" >> $LOG
    python3 $Q --mib $mib --log jobs/$name.guard.log -- "$@" > jobs/$name.out 2>&1; rc=$?
    [ $rc -ne 98 ] && break; [ $n -ge 90 ] && { echo "STEP $name NOT STARTED after $n attempts" >> $LOG; exit 98; }; sleep 5; done
  echo "STEP $name exit=$rc" >> $LOG; [ $rc -eq 0 ] || { echo "CHAIN STOPPED at $name" >> $LOG; exit $rc; }; }
: > $LOG
step snapshot 256 node migrate-ledger-17.mjs snapshot
SNAP=snapshots/$(ls snapshots | sort | tail -1); echo "SNAPSHOT $SNAP" >> $LOG
step stages-test 256 node --test --test-concurrency=1 test/stages.test.mjs
step migration-test 512 node --test --test-concurrency=1 test/migration.test.mjs
step replay 768 node migrate-ledger-17.mjs replay --snapshot $SNAP --migrator $MIGRATOR
REPLAY=rehearsal/replay-$(basename $SNAP .json).json
step plan2 256 node migrate-ledger-17.mjs plan2 --snapshot $SNAP --replay $REPLAY
echo "CHAIN DONE" >> $LOG
