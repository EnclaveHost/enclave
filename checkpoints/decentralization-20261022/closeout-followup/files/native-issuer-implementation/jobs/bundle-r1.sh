#!/usr/bin/env bash
# Rebuild the platform API guest bundle from this tree, check it, then START it: the entry must reach the role's own config read
# (a missing config file is the expected stop), never a bundled CLI's usage text or main check.
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-issuer-implementation/repo
sha256sum relay/network-runtime.bundle.mjs
node scripts/build-platform-api-guest-bundle.mjs
node scripts/build-platform-api-guest-bundle.mjs --check
node --check metal/guest/platform-api.bundle.mjs
for s in "native leaf issued to member" "createNativeIssuer" "signNativeLeaf" "untrustedRead"; do grep -q "$s" metal/guest/platform-api.bundle.mjs || { echo "MISSING $s"; exit 1; }; done
if grep -q "native-control-certificate: " metal/guest/platform-api.bundle.mjs; then echo "CLI text inside the bundle"; exit 1; fi
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
set +e; out=$(timeout 30 node metal/guest/platform-api.bundle.mjs --config "$d/missing.json" 2>&1); rc=$?; set -e
echo "smoke exit=$rc: $out"
[ "$rc" = 1 ] && grep -q "^\[platform-api\] ENOENT: no such file or directory, open '$d/missing.json'" <<<"$out" || { echo "SMOKE FAILED"; exit 1; }
echo BUNDLE-OK
