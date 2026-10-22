#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/site-host-live-publish
while true; do
  python3 ../claude-test-queue.py --mib 512 --log logs/ht8.guard.log -- bash handoff-test-job-3.sh >> logs/ht8.out 2>&1
  rc=$?
  if [ $rc -ne 98 ]; then echo $rc > logs/ht8.rc; break; fi
  sleep 60
done
