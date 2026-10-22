#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/serving
for i in $(seq 1 120); do
  python3 ../../claude-test-queue.py --mib 256 --log probe3.guard.log -- timeout 600 python3 probe3.py >> probe3.out 2>&1
  rc=$?; if [ $rc -ne 98 ]; then echo $rc > probe3.rc; exit; fi; sleep 15
done
echo 98 > probe3.rc
