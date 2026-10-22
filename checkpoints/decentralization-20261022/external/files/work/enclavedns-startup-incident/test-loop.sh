#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-startup-incident
while true; do
  python3 ../claude-test-queue.py --mib 512 --log test.guard.log -- bash test-job.sh >> test.out 2>&1
  rc=$?; if [ $rc -ne 98 ]; then echo $rc > test.rc; break; fi; sleep 30
done
