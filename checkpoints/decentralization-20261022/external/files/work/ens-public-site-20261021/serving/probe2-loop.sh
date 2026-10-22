#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/serving
for i in $(seq 1 120); do
  python3 ../../claude-test-queue.py --mib 256 --log probe2.guard.log -- timeout 600 node probe2.mjs >> probe2.out 2>&1
  rc=$?; if [ $rc -ne 98 ]; then echo $rc > probe2.rc; exit; fi; sleep 15
done
echo 98 > probe2.rc
