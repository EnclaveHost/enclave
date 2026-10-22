#!/usr/bin/env bash
# revision-2 terminal run: the new host-integration suites + every existing suite the changed files touch (bounded)
cd "$(dirname "$0")/tree" && timeout 420 node --test --test-concurrency=1 \
  test/windows-node-wallet-network-hold.test.mjs test/windows-node-appzone-wallet-hold.test.mjs test/windows-node-wallet-enroll.test.mjs \
  test/wallet-network-admission.test.mjs test/host-admission-runtime.test.mjs test/wg-manager.test.mjs test/privacy-agent-lifecycle.test.mjs \
  test/privacy-agent-host-services-start.test.mjs test/windows-node-network-enroll.test.mjs test/windows-node-wallet-policy.test.mjs \
  test/windows-node-tick-single-flight.test.mjs test/windows-node-appzone-abort.test.mjs test/windows-node-appzone-tls.test.mjs 2>&1
echo "== the candidate host-admission bundle itself (ADMISSION_BUNDLE_TEST): $(sha256sum windows/node/host-admission.bundle.mjs | cut -c1-8)"
ADMISSION_BUNDLE_TEST=1 timeout 120 node --test --test-concurrency=1 test/host-admission-runtime.test.mjs 2>&1
