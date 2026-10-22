#!/bin/bash
# one 768 MiB queue job PER SUITE FILE (no accumulation), serially; one summary line per file in $OUT
C=/home/steven/Documents/Codex/2026-10-18/wo/work/existing-custody-audit/candidate; T=${TREE:-$C/compose/final}; LIST=$1; OUT=$2; mkdir -p $C/files; cd $T; : > $OUT
while read f; do
  [ -z "$f" ] && continue; n=$(basename $f .test.mjs)${TAG:+-$TAG}
  for attempt in $(seq 1 60); do
    CARGO_BUILD_JOBS=1 python3 $C/../../claude-test-queue.py --mib ${MIB:-768} --log $C/files/$n.guard.log -- node --test --test-concurrency=1 $f > $C/files/$n.out 2>&1; rc=$?
    [ $rc -ne 98 ] && break; sleep 20
  done
  echo "$f EXIT=$rc $(grep -E '^# (pass|fail|skipped) ' $C/files/$n.out | tr '\n' ' ')$(grep -oE 'peakTreeRssMiB=[0-9]+' $C/files/$n.out | tail -1)" >> $OUT
done < $LIST
echo DONE >> $OUT
