#!/usr/bin/env bash
# one queued monitor round (256 MiB light lane; retry while the small lane is held)
cd "$(dirname "$0")"
for i in $(seq 1 60); do python3 ../claude-test-queue.py --mib 256 --log monitor.guard.log -- timeout 240 python3 monitor.py > monitor.last.out 2>&1; rc=$?; [ $rc -ne 98 ] && break; sleep 5; done
grep -v "NOT STARTED\|\[queue\]\|memory-guard" monitor.last.out
