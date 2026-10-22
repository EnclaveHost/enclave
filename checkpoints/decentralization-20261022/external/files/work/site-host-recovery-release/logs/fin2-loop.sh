#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/site-host-recovery-release
while true; do
  python3 ../claude-test-queue.py --mib 512 --log logs/fin2.guard.log -- bash finish-job.sh >> logs/fin2.out 2>&1
  rc=$?; if [ $rc -ne 98 ]; then echo $rc > logs/fin2.rc; break; fi; sleep 60
done
