#!/bin/bash
# the same node --test files on the pristine e820e2405 worktree (baseline for pre-existing failures)
set -uo pipefail
cd "$(dirname "$0")/../baseline-e820"
export TMPDIR="$(cd .. && pwd)/tmp"
git log -1 --format='HEAD %H'; git status --short | head
exec timeout -k 10 "${JOB_SEC:-900}" node --test --test-force-exit --test-concurrency=1 "$@"
