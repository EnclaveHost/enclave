#!/usr/bin/env bash
# j7: the new daemon file after its cleanup-failure assertion was loosened to the contract (no exact wording): candidate
# (must pass) and the untouched baseline 4c059b9 (negative control: must fail)
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/privacy-startup-cancellation-20261023
export TMPDIR=$W/tmp
cd $W/repo
echo "=== A CANDIDATE $(git rev-parse HEAD) network-diff $(git diff HEAD -- network | sha256sum | cut -c1-16) test $(sha256sum test/privacy-agent-startup-cancel.test.mjs | cut -c1-16)"
timeout -k 5 900 node --test --test-concurrency=1 --test-force-exit --test-timeout=120000 test/privacy-agent-startup-cancel.test.mjs; a=$?
echo "=== A rc=$a"
cd $W/baseline
[ "$(git rev-parse HEAD)" = 4c059b997360483c743deca343c2e42b1b534eeb ] && [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "baseline not pristine"; exit 2; }
cp $W/repo/test/privacy-agent-startup-cancel.test.mjs test/
echo "=== B BASELINE 4c059b9 (negative control)"
timeout -k 5 900 node --test --test-concurrency=1 --test-force-exit --test-timeout=120000 test/privacy-agent-startup-cancel.test.mjs; b=$?
rm -f test/privacy-agent-startup-cancel.test.mjs
echo "=== B rc=$b"
[ "$a" -eq 0 ] && [ "$b" -ne 0 ]
