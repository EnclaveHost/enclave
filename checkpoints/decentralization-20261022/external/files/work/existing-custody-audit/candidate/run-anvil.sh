#!/bin/bash
# one queue job (768 MiB) per suite group, serially; results in anvil-runs/<name>.out
C=/home/steven/Documents/Codex/2026-10-18/wo/work/existing-custody-audit/candidate; cd $C/tree; mkdir -p $C/anvil-runs
name=$1; shift
for attempt in $(seq 1 20); do
  python3 ../../../claude-test-queue.py --mib 768 --log $C/anvil-runs/$name.guard.log -- node --test --test-concurrency=1 "$@" > $C/anvil-runs/$name.out 2>&1; rc=$?
  [ $rc -ne 98 ] && break; sleep 30
done
echo "$name EXIT=$rc $(grep -E '^# (tests|pass|fail|skipped) ' $C/anvil-runs/$name.out | tr '\n' ' ') $(grep -E 'memory-guard\] exit' $C/anvil-runs/$name.out | cut -c1-80)"
