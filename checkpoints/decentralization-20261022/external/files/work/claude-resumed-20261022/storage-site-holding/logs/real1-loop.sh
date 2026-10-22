#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/claude-resumed-20261022/storage-site-holding
for i in $(seq 1 120); do
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log logs/real1.guard.log -- tools/real-adapter-proof.sh >> logs/real1.out 2>&1
  rc=$?; if [ $rc -ne 98 ]; then echo $rc > logs/real1.rc; break; fi; sleep 60
done
