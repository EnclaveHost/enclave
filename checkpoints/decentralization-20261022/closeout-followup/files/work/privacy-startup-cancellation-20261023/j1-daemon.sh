#!/usr/bin/env bash
# j1: the real-daemon startup-cancellation cases + the existing lifecycle cases (post-start SIGTERM -> 0, genuine failure -> 1)
# on the CANDIDATE (must pass); then the new cases on the untouched baseline 4c059b9 (negative control: must fail)
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/privacy-startup-cancellation-20261023
export TMPDIR=$W/tmp; mkdir -p "$TMPDIR"
cd $W/repo
echo "=== CANDIDATE $(git rev-parse HEAD) + worktree diff $(git diff HEAD -- network | sha256sum | cut -c1-16)"
timeout -k 5 600 node --test --test-concurrency=1 --test-force-exit --test-timeout=120000 \
  test/privacy-agent-startup-cancel.test.mjs test/privacy-agent-lifecycle.test.mjs
cd $W/baseline
test "$(git rev-parse HEAD)" = 4c059b997360483c743deca343c2e42b1b534eeb
test -z "$(git status --porcelain --untracked-files=no)"
cp $W/repo/test/privacy-agent-startup-cancel.test.mjs test/
echo "=== BASELINE 4c059b9 (negative control)"
set +e
timeout -k 5 600 node --test --test-concurrency=1 --test-force-exit --test-timeout=120000 test/privacy-agent-startup-cancel.test.mjs
rc=$?
set -e
rm -f test/privacy-agent-startup-cancel.test.mjs
echo "=== BASELINE rc=$rc"
test "$rc" -ne 0
