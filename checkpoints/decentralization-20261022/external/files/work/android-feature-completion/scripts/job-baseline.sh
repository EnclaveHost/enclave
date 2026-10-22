#!/bin/bash
# The groups that failed in the final run, on the PRISTINE base (the frozen candidate tree), same runner, same environment:
# a failure here too is not this work's.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/android-feature-completion; cd $H/pristine
for n in anchor-app anchor-attach-instance anchor-pins anchor-reattach pvm-client-gate pvm-instance-binding-checker pvm-instance-binding pvm-proof-agent-checker pvm-proof-key-checker pvm-proof-key pvm-reattach-hub pvm-relay-reconnect-checker pvm-relay-route-checker pvm-relay-serving pvm-runner-agent-checker pvm-runner-resolver; do node --test --test-concurrency=1 test/$n.test.mjs > $H/logs/base-$n.log 2>&1; rc=$?
  echo "base-$n: exit=$rc $(grep -E '^# (tests|pass|fail|skipped|cancelled)' $H/logs/base-$n.log | tr '\n' ' ')"; done
