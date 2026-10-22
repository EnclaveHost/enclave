#!/usr/bin/env bash
# Model volumes, JavaScript (immutable; v3 = v2 + every suite that drives the real Hyper-V launcher, since its stop now
# also removes - or, for a recovered handle, sweeps - a run's model-volume disks): the suites v1 failed or that changed
# since, with the rest of the Windows manager and plan suites around them.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/tree"
node --test --test-concurrency=1 \
  windows/vbslike/manager/*.test.mjs windows/vbslike/datapath/*.test.mjs \
  test/isolation-claim-gate.test.mjs test/isolation-modelvol-gate.test.mjs test/windows-node-availability-flags.test.mjs \
  test/model-volume-dist.test.mjs \
  test/windows-isolation-manager-restart.test.mjs test/windows-manager-vm-scope.test.mjs test/windows-shield-package-transport.test.mjs \
  test/windows-shield-image-selection.test.mjs test/windows-shield-custody-transport.test.mjs
echo "run-js-v3: PASS"
