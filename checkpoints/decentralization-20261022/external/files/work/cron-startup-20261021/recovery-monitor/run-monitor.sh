#!/bin/bash
# Bounded read-only monitor: at most 10 rounds, about 50 s apart; each round is its own queue job (256 MiB).
M=/home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021/recovery-monitor
cd /home/steven/Documents/Codex/2026-10-18/wo
for r in $(seq 1 10); do
  for i in 1 2 3 4; do python3 work/claude-test-queue.py --mib 256 --log $M/round.guard.log -- python3 $M/monitor-round.py $r >> $M/monitor.out 2>&1; rc=$?; [ $rc -ne 98 ] && break; sleep 15; done
  echo "round $r rc=$rc $(date -u +%T)" >> $M/monitor.out
  python3 -c "import json;s=json.load(open('$M/progress.json'))['summary'];exit(0 if s.get('healthy') else 1)" 2>/dev/null && { echo "HEALTHY at round $r" >> $M/monitor.out; }
  [ $r -lt 10 ] && sleep 50
done
echo DONE >> $M/monitor.out
