#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-control-merged-20261021/root-validation-tree
timeout 420 node --test --test-concurrency=1 test/windows-node-wallet-network-hold.test.mjs test/windows-node-appzone-wallet-hold.test.mjs test/windows-node-wallet-enroll.test.mjs test/windows-node-network-enroll.test.mjs test/windows-node-wallet-policy.test.mjs test/windows-node-tick-single-flight.test.mjs test/windows-node-appzone-abort.test.mjs test/windows-node-appzone-tls.test.mjs test/lease-relay-host-policy.test.mjs test/lease-release-journal-windows.test.mjs test/windows-shield-startup.test.mjs test/windows-manager-judges-partition.test.mjs test/model-volume-dist.test.mjs
