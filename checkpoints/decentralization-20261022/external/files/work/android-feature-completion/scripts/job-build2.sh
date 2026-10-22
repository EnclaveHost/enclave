#!/bin/bash
# after the instance-signature refactor: the payload and APKs again, then the suites that read the payload source or drive it
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/android-feature-completion; fail=0
echo "=== native"; $H/scripts/job-native.sh || fail=1
echo "=== apk"; $H/scripts/build-apk.sh > $H/logs/build-apk2.log 2>&1; rc=$?; tail -8 $H/logs/build-apk2.log; [ $rc -ne 0 ] && fail=1
cd $H/tree
for n in anchor-attach-instance pvm-custody-host; do node --test --test-concurrency=1 test/$n.test.mjs > $H/logs/final3-$n.log 2>&1; rc=$?
  echo "final3-$n: exit=$rc $(grep -E '^# (tests|pass|fail|skipped|cancelled)' $H/logs/final3-$n.log | tr '\n' ' ')"; done
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"; exit $fail
