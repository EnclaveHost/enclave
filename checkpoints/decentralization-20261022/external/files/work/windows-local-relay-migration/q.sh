#!/usr/bin/env bash
# q.sh NAME : queue ./run.sh logs/NAME.log in the background (768 MiB multiprocess lane; retried while NOT STARTED); writes logs/NAME.done
cd "$(dirname "$0")"; NAME=$1; MODE=${2:-}
rm -f "logs/$NAME.done"
nohup bash -c 'for i in $(seq 1 240); do python3 ../claude-test-queue.py --mib 768 --log logs/'"$NAME"'.guard.log -- ./run.sh logs/'"$NAME"'.log '"$MODE"'; e=$?; [ $e -ne 98 ] && break; sleep 15; done; echo $e > logs/'"$NAME"'.done' > "logs/$NAME.nohup" 2>&1 &
echo "queued $NAME (pid $!)"
