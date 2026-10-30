#!/bin/bash
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 || exit 2
bash jobs/q-exit-status.sh root-a2-v2-bound-unit-r2-2336 256 unshare -rn env A2_TEST_RUN=run-r2 sh finality-stage/a2-v2-release-bound/run-tests.sh > logs/root-a2-v2-bound-unit-r2-2336.out 2>&1
r=$?; printf '%s\n' "$r" > logs/root-a2-v2-bound-unit-r2-2336.rc
[ "$r" = 0 ] || exit "$r"
bash jobs/q-exit-status.sh root-a2-v2-bound-mutants-2336 256 unshare -rn bash finality-stage/a2-v2-release-bound/mutants.sh > logs/root-a2-v2-bound-mutants-2336.out 2>&1
r=$?; printf '%s\n' "$r" > logs/root-a2-v2-bound-mutants-2336.rc
exit "$r"
