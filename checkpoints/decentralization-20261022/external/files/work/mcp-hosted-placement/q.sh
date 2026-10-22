#!/usr/bin/env bash
# q.sh MIB NAME STEP... : queue ./run.sh evidence/NAME.log STEP... in the background (retrying while not admitted); writes evidence/NAME.done
cd "$(dirname "$0")"; MIB=$1 NAME=$2; shift 2
rm -f "evidence/$NAME.done"
nohup bash -c 'for i in $(seq 1 240); do python3 ../claude-test-queue.py --mib '"$MIB"' --log evidence/'"$NAME"'.guard.log -- ./run.sh evidence/'"$NAME"'.log '"$*"'; e=$?; [ $e -ne 98 ] && break; sleep 15; done; echo $e > evidence/'"$NAME"'.done' > "evidence/$NAME.nohup" 2>&1 &
echo "queued $NAME (pid $!)"
