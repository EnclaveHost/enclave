#!/usr/bin/env bash
# j4: the suites j3 failed: preclaim + scan-slot (fixtures now read/state the manager's RAM view) and hv-attach-relay
# (j3 lacked the gitignored relay/network-runtime.bundle.mjs; copied byte-identical from the 6f6d22f5 candidate tree)
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-memory-accounting-20261023
export TMPDIR=$W/tmp; mkdir -p "$TMPDIR"
cd $W/repo
timeout -k 5 900 node --test --test-concurrency=1 --test-force-exit --test-timeout=180000 \
  test/windows-node-preclaim.test.mjs test/windows-node-scan-slot.test.mjs test/windows-node-hv-attach-relay.test.mjs
