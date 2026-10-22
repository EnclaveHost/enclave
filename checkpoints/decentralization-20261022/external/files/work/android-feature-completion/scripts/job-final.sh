#!/bin/bash
# Final regression (one queue job, 1024 MiB: some custody suites run Go): every custody suite, every pVM/anchor/AVF suite,
# this work's own suites. One suite file group at a time; each group's TAP in logs/final-<name>.log.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/android-feature-completion; cd $H/tree; fail=0
run() { local name=$1; shift; node --test --test-concurrency=1 "$@" > $H/logs/final-$name.log 2>&1; local rc=$?
  echo "final-$name: exit=$rc $(grep -E '^# (tests|pass|fail|skipped|cancelled)' $H/logs/final-$name.log | tr '\n' ' ')"; [ $rc -ne 0 ] && fail=1; return 0; }
run avf test/custody-v2-avf.test.mjs test/custody-v2-avf-go.test.mjs test/pvm-custody-host.test.mjs
# real-Chromium suites (custody-browser, pvm-browser-lab, pvm-client-{durability,ext-durability,extension}) import none of the
# files this work changes (custody/browser.mjs re-exports only v1 modules and the unchanged custody/rules.mjs; the pVM client
# and web carrier are untouched), so they are not run in this 1024 MiB job
BROWSER="custody-browser|pvm-browser-lab|pvm-client-durability|pvm-client-ext-durability|pvm-client-extension"
for f in $(ls test/custody*.test.mjs test/shield-custody.test.mjs test/independent-custody-cli.test.mjs | grep -v "custody-v2-avf" | grep -Ev "$BROWSER"); do
  n=$(basename $f .test.mjs)
  if [ $n = custody-v2-build ]; then GIT_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git run $n $f; else run $n $f; fi
done
for f in $(ls test/pvm-*.test.mjs test/anchor-*.test.mjs test/avf-*.test.mjs | grep -v pvm-custody-host | grep -Ev "$BROWSER"); do run $(basename $f .test.mjs) $f; done
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"; exit $fail
