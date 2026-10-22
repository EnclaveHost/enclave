#!/bin/sh
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-config-independent-review-20261021/src-g4
cp network/enclave-network-host.mjs /tmp/enh-patched.mjs; cp ../patches/enclave-network-host.21181cb2.orig.mjs network/enclave-network-host.mjs
echo "NEGATIVE: network-host $(sha256sum network/enclave-network-host.mjs | cut -c1-12)"
node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern="judges challengeReplica before anything binds" test/challenge-replica-host.test.mjs 2>&1 | grep -E "^(ok|not ok)|^# (pass|fail)"
node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern="refuses a managed front" test/challenge-front-managed.test.mjs 2>&1 | grep -E "^(ok|not ok)|^# (pass|fail)"
cp /tmp/enh-patched.mjs network/enclave-network-host.mjs; rm -f /tmp/enh-patched.mjs
echo "restored: network-host $(sha256sum network/enclave-network-host.mjs | cut -c1-12)"
