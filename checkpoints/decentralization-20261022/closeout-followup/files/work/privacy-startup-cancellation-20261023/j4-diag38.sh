#!/usr/bin/env bash
# j4: diagnose j3's one unexpected coupled failure (cold-start "zero apps, unknown chain policy": STARTED while the policy
# should be unreadable). The SAME test, with its daemon output printed, once on the candidate and once on the baseline.
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/privacy-startup-cancellation-20261023
export TMPDIR=$W/tmp
for tree in repo baseline; do
  cd $W/$tree; cp $W/diag/zz-diag-38.test.mjs test/
  echo "=== $tree $(git rev-parse HEAD)"
  timeout -k 5 120 node --test --test-concurrency=1 --test-force-exit --test-name-pattern="unknown chain policy" test/zz-diag-38.test.mjs; echo "=== $tree rc=$?"
  rm -f test/zz-diag-38.test.mjs
done
