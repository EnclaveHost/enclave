#!/usr/bin/env bash
# the existing suites the revision-2 files touch, against revision2/tree
cd "$(dirname "$0")/tree" && node --test --test-concurrency=1 test/wg-manager.test.mjs test/privacy-agent-lifecycle.test.mjs test/privacy-agent-host-services-start.test.mjs test/windows-node-network-enroll.test.mjs test/windows-node-wallet-policy.test.mjs test/windows-node-tick-single-flight.test.mjs 2>&1 | grep -E "^(not )?ok|^# (tests|pass|fail)|AssertionError|Error:" | head -80
