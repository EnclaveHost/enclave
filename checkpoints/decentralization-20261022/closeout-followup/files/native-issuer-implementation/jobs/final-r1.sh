#!/usr/bin/env bash
# Final evidence over the committed tree state: syntax, bundle check (stale bundle refused), and all four suites.
set -uo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-issuer-implementation/repo
rc=0
for f in metal/guest/native-certificate.mjs metal/guest/native-issuer.mjs metal/guest/platform-api-role.mjs scripts/native-control-certificate.mjs scripts/build-platform-api-guest-bundle.mjs; do node --check "$f" || rc=1; done
node scripts/build-platform-api-guest-bundle.mjs || rc=1
node scripts/build-platform-api-guest-bundle.mjs --check || rc=1
grep -q "native-control-certificate: " metal/guest/platform-api.bundle.mjs && { echo "CLI text inside the bundle"; rc=1; }
d=$(mktemp -d); out=$(timeout 30 node metal/guest/platform-api.bundle.mjs --config "$d/missing.json" 2>&1); sr=$?; rm -rf "$d"
echo "bundle smoke exit=$sr: $out"; { [ $sr = 1 ] && grep -q "^\[platform-api\] ENOENT" <<<"$out"; } || { echo SMOKE-FAILED; rc=1; }
for t in test/native-certificate-leaf.test.mjs test/platform-api-native-issuer.test.mjs test/native-control-attested.test.mjs test/platform-api-hosted.test.mjs; do
  echo "=== $t"; timeout -k 5 150 node --test --test-concurrency=1 --test-force-exit "$t"; r=$?; echo "=== $t exit=$r"; [ $r -ne 0 ] && rc=1
done
exit $rc
