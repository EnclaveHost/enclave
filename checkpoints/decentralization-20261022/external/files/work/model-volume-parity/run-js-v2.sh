#!/usr/bin/env bash
# Model volumes, JavaScript (immutable; v2): the suites v1 failed or that changed since (the launcher's separate disk
# attach, the claim gate's model-volume wording), with the rest of the Windows manager and plan suites around them.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/tree"
node --test --test-concurrency=1 \
  windows/vbslike/manager/*.test.mjs windows/vbslike/datapath/*.test.mjs \
  test/isolation-claim-gate.test.mjs test/isolation-modelvol-gate.test.mjs test/windows-node-availability-flags.test.mjs \
  test/model-volume-dist.test.mjs
echo "run-js-v2: PASS"
