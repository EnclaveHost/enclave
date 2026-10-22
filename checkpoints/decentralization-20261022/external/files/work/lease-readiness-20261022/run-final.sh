#!/bin/bash
set -euo pipefail
export PWSH="$(cd "$(dirname "$0")/.." && pwd)/node-hold-package-20261021/tools/pwsh/pwsh"
cd "$(dirname "$0")/tree"
timeout 180 node --test --test-concurrency=1 test/windows-node-lease-readiness.test.mjs test/windows-node-tick-single-flight.test.mjs test/windows-node-wallet-policy.test.mjs test/windows-node-wallet-network-hold.test.mjs test/windows-node-appzone-wallet-hold.test.mjs test/windows-node-wallet-enroll.test.mjs test/windows-node-network-enroll.test.mjs test/host-service-transport.test.mjs > ../final.out 2>&1
cat ../final.out
