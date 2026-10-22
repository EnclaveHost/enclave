#!/bin/sh
# qrun.sh NAME MIB DIR cmd...: one job through the coordinator's queue, retried while it answers 98 (NOT STARTED), at most 6 times.
W=/home/steven/Documents/Codex/2026-10-18/wo/work; L=$W/storage-front-binding/logs; NAME=$1; MIB=$2; DIR=$3; shift 3
cd $DIR || exit 9
for i in 1 2 3 4 5 6; do
  env -u GIT_DIR -u GIT_WORK_TREE python3 $W/claude-test-queue.py --mib $MIB --log $L/$NAME.guard.log -- timeout 1500 "$@" > $L/$NAME.log 2>&1
  c=$?; [ $c -ne 98 ] && break; sleep 20
done
echo "QUEUE_EXIT $c"; grep -E "^(not )?ok |^--- FAIL|^FAIL|^ok |^PASS|^# (pass|fail)|cannot|undefined|error" $L/$NAME.log | head -40; grep peak $L/$NAME.guard.log | tail -1
