#!/usr/bin/env bash
# queue-retry.sh MIB NAME -- CMD...   (cwd work/app-lease-gas): retry the shared queue on 98 (not started), then record
# the terminal exit in logs/r3/NAME.done. Output: logs/r3/NAME.out; guard log: logs/r3/NAME.guard.log.
set -u
mib=$1; name=$2; shift 3
for i in $(seq 1 600); do
  python3 ../claude-test-queue.py --mib "$mib" --log "$PWD/logs/r3/$name.guard.log" -- "$@"; e=$?
  [ $e -ne 98 ] && break; sleep 20
done
echo "exit $e" > "logs/r3/$name.done"
