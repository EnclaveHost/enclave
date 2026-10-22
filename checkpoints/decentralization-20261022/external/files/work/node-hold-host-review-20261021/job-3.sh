#!/usr/bin/env bash
set -uo pipefail
D=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-host-review-20261021; T=$D/tree; cd "$T"
s(){ grep -E "^# (pass|fail)" | tr '\n' ' '; }
echo "files: $(sha256sum network/wallet-admission.mjs windows/node/host.mjs | cut -c1-12 | tr '\n' ' ')"
echo "sharing-retry (PATCHED): $(timeout 120 node --test test/wallet-admission-sharing-retry-7d.test.mjs 2>&1 | s)"
cp $D/proposed/wallet-admission.mjs.orig network/wallet-admission.mjs
echo "sharing-retry (ORIGINAL writer, control): $(timeout 120 node --test test/wallet-admission-sharing-retry-7d.test.mjs 2>&1 | grep -E '^(not )?ok|^# (pass|fail)' | tr '\n' ' ')"
cp $D/proposed/wallet-admission.mjs.proposed network/wallet-admission.mjs
for t in wallet-network-admission hold-review windows-node-wallet-network-hold windows-node-appzone-wallet-hold windows-node-wallet-enroll host-hold-review-7d; do
  echo "$t (patched writer, host 90de17ed): $(timeout 300 node --test --test-concurrency=1 test/$t.test.mjs 2>&1 | s) $(timeout 1 true)"
done
