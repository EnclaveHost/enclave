#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/site-host-recovery-release
while true; do
  python3 ../claude-test-queue.py --mib 1024 --log logs/rs3.guard.log -- bash recovery-site-job.sh >> logs/rs3.out 2>&1
  rc=$?; if [ $rc -ne 98 ]; then echo $rc > logs/rs3.rc; break; fi; sleep 60
done
