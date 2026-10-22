#!/bin/sh
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-config-independent-review-20261021/src-g4
echo "network-host $(sha256sum network/enclave-network-host.mjs | cut -c1-12) replica-host $(sha256sum network/challenge-replica-host.mjs | cut -c1-12)"
node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern="judges challengeReplica before anything binds" test/challenge-replica-host.test.mjs 2>&1 | grep -E "^(ok|not ok)|^# (pass|fail|skipped)|Error|assert" | head -20
