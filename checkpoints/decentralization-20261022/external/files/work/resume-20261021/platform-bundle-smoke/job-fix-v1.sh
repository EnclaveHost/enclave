#!/usr/bin/env bash
# ONE queued job (1024 MiB). (1) Build platform-api.bundle.mjs WITH the argv-guard packaging fix (fix/b over a scratch copy of
# candidate 6163e2e7 + real node_modules; relay/build-network.mjs first), twice (reproducible), --check, node --check.
# (2) The artifact smoke (harness/bundle-smoke.test.mjs) on: the FIXED bundle (must pass 6/6), the CURRENT candidate bundle
# e7a4fc1d and the PREVIOUS 6e2f81cf (negative controls). Only the platform-api bundle is built. The candidate is untouched.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; R=$W/resume-20261021; H=$R/platform-bundle-smoke; S=$H/tree
export GIT_OPTIONAL_LOCKS=0 TMPDIR=$H/tmp
date -u +%FT%TZ > "$H/fix-started.utc"
rm -rf "$S" "$TMPDIR" "$H/fix/out" "$H/fix/out2"; mkdir -p "$TMPDIR"
cp -a "$R/reconciled-candidate" "$S"
for nm in node_modules relay/node_modules sdk/sessions/node_modules network/node_modules e2e/node_modules; do cp -a "$W/enclave/$nm" "$S/$nm"; done
cp -a "$H/fix/b/." "$S/"
cd "$S"
node relay/build-network.mjs > "$H/fix-network-runtime.out"; cat "$H/fix-network-runtime.out"
node scripts/build-platform-api-guest-bundle.mjs --out "$H/fix/out"
node scripts/build-platform-api-guest-bundle.mjs --out "$H/fix/out2"
cmp "$H/fix/out/platform-api.bundle.mjs" "$H/fix/out2/platform-api.bundle.mjs"; cmp "$H/fix/out/platform-api.bundle.mjs.manifest.json" "$H/fix/out2/platform-api.bundle.mjs.manifest.json"
echo "REPRODUCIBLE"
cp "$H/fix/out/platform-api.bundle.mjs" "$H/fix/out/platform-api.bundle.mjs.manifest.json" metal/guest/
node scripts/build-platform-api-guest-bundle.mjs --check
node --check metal/guest/platform-api.bundle.mjs && echo "SYNTAX-OK"
mkdir -p "$H/run/fixed/opt/metal/fixtures"
cp "$H/fix/out/platform-api.bundle.mjs" "$H/run/fixed/opt/metal/"; cp relay/fixtures/tpm-roots.pem "$H/run/fixed/opt/metal/fixtures/"
cd "$H/harness"
set +e
for v in fixed new old; do BUNDLE_DIR="$H/run/$v/opt/metal" node --test --test-concurrency=1 --test-reporter=tap bundle-smoke.test.mjs > "$H/$v.tap" 2>&1; echo "$v-rc=$?"; done
set -e
for v in fixed new old; do echo "== $v $(sha256sum "$H/run/$v/opt/metal/platform-api.bundle.mjs" | cut -c1-64)"; grep -E "^(not )?ok [0-9]+ |^# (tests|pass|fail|skipped|cancelled)" "$H/$v.tap"; done
sha256sum "$H/fix/out/"* "$H/run/fixed/opt/metal/fixtures/tpm-roots.pem"
date -u +%FT%TZ > "$H/fix-finished.utc"
grep -q "^# fail 0" "$H/fixed.tap" && grep -q "^# skipped 0" "$H/fixed.tap" && grep -q "^# pass 6" "$H/fixed.tap" || { echo "FIXED BUNDLE FAILED"; exit 1; }
rm -rf "$S"
echo FIX-SMOKE-OK
