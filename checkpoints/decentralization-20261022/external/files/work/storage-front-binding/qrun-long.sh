#!/bin/sh
# qrun-long.sh NAME MIB DIR cmd...: as qrun.sh, retried while the queue answers 98, at most 150 times (~3 h bound).
W=/home/steven/Documents/Codex/2026-10-18/wo/work; L=$W/storage-front-binding/logs; NAME=$1; MIB=$2; DIR=$3; shift 3
cd $DIR || exit 9
i=0
while [ $i -lt 150 ]; do
  i=$((i+1))
  env -u GIT_DIR -u GIT_WORK_TREE python3 $W/claude-test-queue.py --mib $MIB --log $L/$NAME.guard.log -- timeout 2400 "$@" > $L/$NAME.log 2>&1
  c=$?; [ $c -ne 98 ] && break; sleep 15
done
echo "QUEUE_EXIT $c attempts $i" > $L/$NAME.done
