#!/bin/sh
# qrun.sh NAME MIB DIR cmd...: one job through work/claude-test-queue.py, retried while it answers 98 (NOT STARTED), at most
# 150 times; terminal status in logs/NAME.done.
W=/home/steven/Documents/Codex/2026-10-18/wo/work; L=$W/linux-lease-activation/logs; NAME=$1; MIB=$2; DIR=$3; shift 3
cd $DIR || exit 9
rm -f $L/$NAME.done
i=0
while [ $i -lt 150 ]; do
  i=$((i+1))
  env -u GIT_DIR -u GIT_WORK_TREE python3 $W/claude-test-queue.py --mib $MIB --log $L/$NAME.guard.log -- timeout 2400 "$@" > $L/$NAME.log 2>&1
  c=$?; [ $c -ne 98 ] && break; sleep 15
done
echo "QUEUE_EXIT $c attempts $i" > $L/$NAME.done
