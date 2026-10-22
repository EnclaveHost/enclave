#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/site-host-live-publish
while true; do
  python3 ../claude-test-queue.py --mib 512 --log logs/ht9.guard.log -- bash handoff-test-job-4.sh >> logs/ht9.out 2>&1
  rc=$?; if [ $rc -ne 98 ]; then echo $rc > logs/ht9.rc; break; fi; sleep 60
done
