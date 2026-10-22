#!/usr/bin/env bash
# Model volumes, JavaScript, FINAL tree state (immutable): every suite of run-js-v1.sh and run-js-v3.sh.
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
  test/windows-node-retired-engine.test.mjs test/windows-node-retired-engine-agent.test.mjs test/windows-node-prove-isolated.test.mjs \
  test/windows-isolation-manager-restart.test.mjs test/windows-manager-vm-scope.test.mjs test/windows-shield-package-transport.test.mjs \
  test/windows-shield-image-selection.test.mjs test/windows-shield-custody-transport.test.mjs
echo "run-js-final: PASS"
