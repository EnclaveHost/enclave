#!/usr/bin/env bash
# j2: the focused regressions on the candidate (must pass), then the SAME files on the untouched baseline 6f6d22f5
# (original negative control: must fail, on the overstated free RAM and the installer clamp)
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-memory-accounting-20261023
export TMPDIR=$W/tmp; mkdir -p "$TMPDIR"
T="test/windows-hv-memory-accounting.test.mjs test/windows-installer-app-ram.test.mjs"
cd $W/repo
echo "=== CANDIDATE $(git rev-parse HEAD) + worktree diff"
timeout -k 5 300 node --test --test-concurrency=1 --test-force-exit --test-timeout=120000 $T
cd $W/baseline
test "$(git rev-parse HEAD)" = 6f6d22f5da31bb40b3131deb1f719291602682d0
test -z "$(git status --porcelain --untracked-files=no)"
cp $W/repo/test/windows-hv-memory-accounting.test.mjs $W/repo/test/windows-installer-app-ram.test.mjs test/
echo "=== BASELINE 6f6d22f5 (negative control)"
set +e
timeout -k 5 300 node --test --test-concurrency=1 --test-force-exit --test-timeout=120000 $T
rc=$?
set -e
rm -f test/windows-hv-memory-accounting.test.mjs test/windows-installer-app-ram.test.mjs
echo "=== BASELINE rc=$rc"
test "$rc" -ne 0
