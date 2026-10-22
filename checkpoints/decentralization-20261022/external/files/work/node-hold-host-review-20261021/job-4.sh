#!/usr/bin/env bash
set -uo pipefail
D=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-host-review-20261021; L=$D/tree-live
echo "== bundle reproduction (my copy of 605's build.sh d36e5d21)"; bash $D/bundle-build/build-7d.sh 2>&1 | grep -E "PROVENANCE|rebuilt|decision|metal|candidate.host-admission|MIRROR"
cd $L; s(){ grep -E "^# (pass|fail)" | tr '\n' ' '; }
echo "== tree-live copy: $(sha256sum windows/node/host.mjs network/wallet-admission.mjs | cut -c1-8 | tr '\n' ' ')"
echo "605 live list: $(timeout 420 node --test --test-concurrency=1 test/windows-node-wallet-network-hold.test.mjs test/windows-node-appzone-wallet-hold.test.mjs test/windows-node-wallet-enroll.test.mjs test/windows-node-network-enroll.test.mjs test/windows-node-wallet-policy.test.mjs test/windows-node-tick-single-flight.test.mjs test/windows-node-appzone-abort.test.mjs test/windows-node-appzone-tls.test.mjs 2>&1 | s)"
echo "7d lifecycle: $(timeout 180 node --test --test-concurrency=1 test/host-hold-review-7d.test.mjs 2>&1 | s)"
echo "sharing-retry ORIGINAL writer (control): $(timeout 120 node --test test/wallet-admission-sharing-retry-7d.test.mjs 2>&1 | s)"
cp $D/proposed/wallet-admission.mjs.proposed network/wallet-admission.mjs
echo "sharing-retry PATCHED writer: $(timeout 120 node --test test/wallet-admission-sharing-retry-7d.test.mjs 2>&1 | s)"
echo "hold suite PATCHED writer: $(timeout 300 node --test --test-concurrency=1 test/windows-node-wallet-network-hold.test.mjs 2>&1 | s)"
echo "wallet-network-admission PATCHED writer: $(timeout 300 node --test --test-concurrency=1 test/wallet-network-admission.test.mjs 2>&1 | s)"
cp $D/proposed/wallet-admission.mjs.orig network/wallet-admission.mjs; echo "restored writer $(sha256sum network/wallet-admission.mjs | cut -c1-8)"
