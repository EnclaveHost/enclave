#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclave
node scripts/build-host-admission.mjs
node scripts/build-host-policy-vendor.mjs --allow-uncommitted
(cd relay && node build-network.mjs)
node --test --test-concurrency=1 test/platform-host-policy.test.mjs test/host-policy-enforcement.test.mjs test/host-policy-callsites.test.mjs test/windows-node-platform-policy.test.mjs test/custody-v2-book-vault.test.mjs test/custody-v2-chain-quorum.test.mjs test/custody-v2-host-ownership.test.mjs test/custody-v2-release-authority.test.mjs test/host-admission-runtime.test.mjs test/host-policy-mirrors.test.mjs test/platform-policy-mirror-bounds.test.mjs test/site-host-policy.test.mjs test/proof-of-time.test.mjs test/native-policy.test.mjs test/management-plane.test.mjs test/platform-host-policy-process.test.mjs test/relay-deploy-closure.test.mjs test/custody-v2-original-vault-e2e.test.mjs test/service-index.test.mjs test/route-record.test.mjs test/public-directory.test.mjs
node --test ../storage-front-resource-review/reproduce.test.mjs
if POLICY_MIRROR_TEST_SOURCE=/home/steven/Documents/Codex/2026-10-18/wo/work/platform-mirror-bounds/original.mjs node --test test/platform-policy-mirror-bounds.test.mjs > ../platform-mirror-bounds/negative.log 2>&1; then
  echo 'ERROR: original unbounded mirror unexpectedly passed'
  exit 1
fi
python3 - <<'CHECK'
from pathlib import Path
s=Path('../platform-mirror-bounds/negative.log').read_text()
assert '# tests 6' in s and '# fail 5' in s and '# pass 1' in s and '# cancelled 0' in s, s[-3000:]
print('Original mirror negative control:5expected failures,1deadline control passes')
CHECK
