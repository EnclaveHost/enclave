#!/bin/bash
# one queue job (768 MiB) per part, serially; results in forge-parts/<part>.out
C=/home/steven/Documents/Codex/2026-10-18/wo/work/existing-custody-audit/candidate; cd $C
for D in "$@"; do
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    python3 ../../claude-test-queue.py --mib 768 --log $C/forge-parts/$D.guard.log -- forge test --root forge-parts/$D -j 1 -vv > forge-parts/$D.out 2>&1; rc=$?
    [ $rc -ne 98 ] && break; sleep 30
  done
  echo "$D EXIT=$rc $(grep -E 'Suite result' forge-parts/$D.out | cut -c1-120) $(grep -E 'memory-guard\] exit' forge-parts/$D.out | cut -c1-90)"
done
