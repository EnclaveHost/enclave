#!/usr/bin/env bash
# Retries ONLY on queue exit 98 (job not started); any started run's exit is final.
set -uo pipefail
C=/home/steven/Documents/Codex/2026-10-18/wo/work/nucbox-tls-20261021/combined
cd /home/steven/Documents/Codex/2026-10-18/wo
for i in $(seq 1 20); do
  python3 work/claude-test-queue.py --mib 1024 --log $C/fixture-test.guard.log -- python3 $C/fixture_test.py > $C/fixture-test.out 2>&1; rc=$?
  [ $rc -ne 98 ] && { echo "attempt $i rc=$rc"; exit $rc; }
  echo "attempt $i NOT STARTED (98)"; sleep 45
done
exit 98
