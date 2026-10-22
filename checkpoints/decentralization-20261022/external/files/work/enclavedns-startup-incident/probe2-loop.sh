#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-startup-incident
while true; do
  python3 ../claude-test-queue.py --mib 256 --log probe2.guard.log -- python3 probe2.py >> probe2.queue.out 2>&1
  rc=$?; if [ $rc -ne 98 ]; then echo $rc > probe2.rc; break; fi; sleep 20
done
