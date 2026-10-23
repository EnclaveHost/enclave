#!/usr/bin/env bash
# j1: the two new focused regression files, on the candidate (repo/), one file at a time
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/windows-memory-accounting-20261023/repo
export TMPDIR=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-memory-accounting-20261023/tmp
mkdir -p "$TMPDIR"
timeout -k 5 300 node --test --test-concurrency=1 --test-force-exit --test-timeout=120000 \
  test/windows-hv-memory-accounting.test.mjs test/windows-installer-app-ram.test.mjs
