#!/bin/bash
# one 768 MiB queue job per batch of affected suites, serially, in the composed tree; summaries in batches/
C=/home/steven/Documents/Codex/2026-10-18/wo/work/existing-custody-audit/candidate; T=${TREE:-$C/compose/final}; mkdir -p $C/batches; cd $T
for b in "$@"; do
  name=$(basename $b)$( [ -n "$TAG" ] && echo "-$TAG")
  for attempt in $(seq 1 40); do
    CARGO_BUILD_JOBS=1 python3 $C/../../claude-test-queue.py --mib 768 --log $C/batches/$name.guard.log -- node --test --test-concurrency=1 $(cat $b) > $C/batches/$name.out 2>&1; rc=$?
    [ $rc -ne 98 ] && break; sleep 30
  done
  echo "$name EXIT=$rc $(grep -E '^# (tests|pass|fail|skipped) ' $C/batches/$name.out | tr '\n' ' ') $(grep -E 'memory-guard\] exit' $C/batches/$name.out | cut -c1-60)"
  grep -E "^not ok" $C/batches/$name.out | sed 's/^/    /'
done
