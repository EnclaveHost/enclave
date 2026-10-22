#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/tree"
timeout 180 node --test --test-concurrency=1 test/windows-node-tick-single-flight.test.mjs test/windows-node-wallet-policy.test.mjs test/windows-node-wallet-network-hold.test.mjs test/windows-node-appzone-wallet-hold.test.mjs test/windows-node-wallet-enroll.test.mjs > ../compat.out 2>&1
cat ../compat.out
