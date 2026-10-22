#!/bin/sh
# qrun.sh NAME file...: one suite through the coordinator's queue (512 MiB, no swap, 16 GiB floor), retried while the
# queue answers 98 (NOT STARTED), at most 6 times; the job itself is bounded by `timeout`.
W=/home/steven/Documents/Codex/2026-10-18/wo/work; L=$W/measured-control-final-integration/logs; NAME=$1; shift
cd ${MCF_TREE:-$W/measured-control-final-integration/tree} || exit 9
for i in 1 2 3 4 5 6; do
  env -u GIT_DIR -u GIT_WORK_TREE python3 $W/claude-test-queue.py --mib 512 --log $L/$NAME.guard.log -- timeout 1200 node --test --experimental-test-isolation=none --test-concurrency=1 --test-timeout=1100000 "$@" > $L/$NAME.log 2>&1
  c=$?; [ $c -ne 98 ] && break; sleep 20
done
echo "QUEUE_EXIT $c"; grep -E "^\[queue\]|^(not )?ok|^# (tests|pass|fail)" $L/$NAME.log; grep -n -A8 "error:" $L/$NAME.log | head -30 | cut -c1-400
