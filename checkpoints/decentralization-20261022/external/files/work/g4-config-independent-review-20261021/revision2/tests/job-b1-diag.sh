#!/bin/sh
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-config-independent-review-20261021/revision2/network-tree
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="supervised: a transient" test/challenge-replica-supervise.test.mjs 2>&1 | grep -v "^\s*at " | head -40
echo "==== BASE (52d6f679 / 21181cb2 / original tests): the REAL-gate tests"
mkdir -p /tmp/rgbase && cp network/challenge-replica-host.mjs /tmp/rgbase/crh.mjs && cp network/enclave-network-host.mjs /tmp/rgbase/enh.mjs && cp test/challenge-replica-host.test.mjs /tmp/rgbase/t.mjs
cp ../base/challenge-replica-host.52d6f679.mjs network/challenge-replica-host.mjs; cp ../base/enclave-network-host.21181cb2.mjs network/enclave-network-host.mjs; cp ../base/challenge-replica-host.test.orig.mjs test/challenge-replica-host.test.mjs
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="REAL" test/challenge-replica-host.test.mjs 2>&1 | grep -v "^\s*at " | grep -E "✔|✖|Error|message|rejects|expected|actual" | head -20
cp /tmp/rgbase/crh.mjs network/challenge-replica-host.mjs; cp /tmp/rgbase/enh.mjs network/enclave-network-host.mjs; cp /tmp/rgbase/t.mjs test/challenge-replica-host.test.mjs; rm -rf /tmp/rgbase
echo "restored: $(sha256sum network/challenge-replica-host.mjs network/enclave-network-host.mjs | cut -c1-12 | tr '\n' ' ')"
