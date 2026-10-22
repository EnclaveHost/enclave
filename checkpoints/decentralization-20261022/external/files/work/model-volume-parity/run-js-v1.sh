#!/usr/bin/env bash
# Model volumes, JavaScript (immutable; v1), through the candidate tree: distribution + fixed VHD + root rule on a real
# volume; the Windows host (store, manager admission and /health, launcher disks, node plan, node features); the SNP
# supervisor gate; and the suites those files belong to, as regressions. One file at a time (the queue's cap).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/tree"
node --check supervisor.js
node --test --test-concurrency=1 \
  test/model-volume-dist.test.mjs test/raw-artifacts.test.mjs \
  windows/vbslike/manager/*.test.mjs windows/vbslike/datapath/*.test.mjs \
  test/isolation-modelvol-gate.test.mjs test/isolation-encvol-gate.test.mjs test/isolation-claim-gate.test.mjs \
  test/isolation-guest-pool.test.mjs test/isolation-release-ticket.test.mjs test/isolation-tee-preference.test.mjs \
  test/bootstrap-supervisor.test.mjs test/custody-supervisor.test.mjs \
  test/windows-node-availability-flags.test.mjs test/windows-node-isolation-host.test.mjs test/windows-node-preclaim.test.mjs \
  test/windows-node-retired-engine.test.mjs test/windows-node-retired-engine-agent.test.mjs test/windows-node-prove-isolated.test.mjs
echo "run-js-v1: PASS"
