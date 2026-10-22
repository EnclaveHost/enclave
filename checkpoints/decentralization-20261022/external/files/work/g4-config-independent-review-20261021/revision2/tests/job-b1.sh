#!/bin/sh
# revision2 B1 focused tests (queue 256), on revision2/network-tree (= G4 composition src + the B1 patch)
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-config-independent-review-20261021/revision2/network-tree
echo "replica-host $(sha256sum network/challenge-replica-host.mjs | cut -c1-12) network-host $(sha256sum network/enclave-network-host.mjs | cut -c1-12)"
T="node --test --test-concurrency=1 --test-reporter=tap"
for f in test/challenge-replica-supervise.test.mjs test/challenge-front-managed.test.mjs; do echo "== $f"; timeout 300 $T $f 2>&1 | grep -E "^(ok|not ok)|^# (pass|fail)|^\s+(error|expected|actual|message):" | head -30; done
echo "== challenge-replica-host (unit tests, not the openssl e2e)"; timeout 300 $T --test-name-pattern="configuration|child environment|release must hold|cannot be spawned|REAL platform host policy gate|host policy carriers|REAL gate with carriers|judges challengeReplica" test/challenge-replica-host.test.mjs 2>&1 | grep -E "^(ok|not ok)|^# (pass|fail)" 
