#!/bin/sh
# qrun.sh NAME MIB file...: one node test job through the coordinator's queue (no swap, 16 GiB floor), retried while
# the queue answers 98 (NOT STARTED), at most 6 times; the job itself is bounded by `timeout`. Serial (--test-concurrency=1).
W=/home/steven/Documents/Codex/2026-10-18/wo/work; L=$W/offchain-heartbeat/logs; NAME=$1; MIB=$2; shift 2
cd $W/offchain-heartbeat/tree || exit 9
for i in 1 2 3 4 5 6; do
  env -u GIT_DIR -u GIT_WORK_TREE python3 $W/claude-test-queue.py --mib $MIB --log $L/$NAME.guard.log -- timeout 1200 node --test --test-concurrency=1 --test-timeout=1100000 "$@" > $L/$NAME.log 2>&1
  c=$?; [ $c -ne 98 ] && break; sleep 20
done
echo "QUEUE_EXIT $c"; grep -E "^(not )?ok|^# (tests|pass|fail|skipped)" $L/$NAME.log; grep -n -B2 -A14 "^not ok" $L/$NAME.log | grep -E "error:|expected|actual|message|not ok|at .*test\.mjs" | head -40 | cut -c1-400; grep "peak" $L/$NAME.guard.log | tail -1
