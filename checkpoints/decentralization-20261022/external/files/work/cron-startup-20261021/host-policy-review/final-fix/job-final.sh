#!/usr/bin/env bash
# ONE queued job (512 MiB): provenance-exact baseline, the final bundle, the 37 existing tests (unchanged), the focused new
# tests on the final bundle/source, and a targeted negative control of the two new properties on v4. Isolated tree; no
# edit of main, the candidate (host-policy/fix3) or the live host.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; F=$W/cron-startup-20261021/host-policy-review/final-fix; H=$W/cron-startup-20261021/host-policy
T=$F/tree; V=$F/tree-v4; O=$F/out
export TMPDIR=$F/tmp; rm -rf "$T" "$V" "$O" "$TMPDIR"; mkdir -p "$TMPDIR" "$O"
DEPLOYED=7ce23a55c9ffccf1c30c818ef3d7a6774cf3c8743fcac62a1421d11456794fc6
rsync -a --exclude .git --exclude node_modules "$W/enclave/" "$T/"
for nm in node_modules network/node_modules relay/node_modules sdk/sessions/node_modules e2e/node_modules windows/node/node_modules; do [ -d "$W/enclave/$nm" ] && ln -s "$W/enclave/$nm" "$T/$nm"; done
cd "$T"
echo "== 1. provenance: main + PRODUCTION_MIRRORS [] must rebuild the DEPLOYED bundle byte for byte"
cp "$F/src/network/platform-host-policy-config.mjs" network/
node scripts/build-host-admission.mjs
B=$(sha256sum windows/node/host-admission.bundle.mjs | cut -d' ' -f1); echo "baseline $B"
[ "$B" = "$DEPLOYED" ] && cmp windows/node/host-admission.bundle.mjs "$H/harness/deployed-7ce23a55.bundle.mjs" && echo "PROVENANCE OK: == deployed 7ce23a55" || { echo "PROVENANCE MISMATCH"; exit 1; }
cp metal/guest/host-policy.bundle.mjs "$O/baseline.host-policy.bundle.mjs"
echo "== 2. v4 bundle (negative control only)"
cp "$H/fix3/b/network/host-admission-runtime.mjs" "$H/fix3/b/network/lease-reader.mjs" network/
node scripts/build-host-admission.mjs; cp windows/node/host-admission.bundle.mjs "$O/v4.bundle.mjs"
echo "== 2b. negative control: B1 and L4 on v4 (tree holds v4 sources now; expected to FAIL individually)"
mkdir -p test/final-fix; cp "$F/test/admission-retry.test.mjs" test/final-fix/
set +e; ADMISSION_MODULE="$O/v4.bundle.mjs" LEASE_READER="$T/network/lease-reader.mjs" node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern "^(B1|L4) " test/final-fix/admission-retry.test.mjs > "$O/negative-v4.tap" 2>&1; vrc=$?; set -e
grep -E "^(not )?ok [0-9]+ |^# (tests|pass|fail|skipped)" "$O/negative-v4.tap"; echo "v4-rc=$vrc"
VFAIL=$(grep -cE "^not ok [0-9]+ - (B1|L4) " "$O/negative-v4.tap" || true)
echo "== 3. FINAL bundle"
cp "$F/src/network/host-admission-runtime.mjs" "$F/src/network/lease-reader.mjs" network/
node scripts/build-host-admission.mjs
cp windows/node/host-admission.bundle.mjs "$O/final.host-admission.bundle.mjs"; cp metal/guest/host-policy.bundle.mjs "$O/final.host-policy.bundle.mjs"
node --check "$O/final.host-admission.bundle.mjs"
sha256sum "$O"/*.mjs
if grep -q "134\.199\.235\.187\|134\.209\.248\.172\|165\.245\.191\.129\|146\.190\.246\.39" "$O/final.host-admission.bundle.mjs"; then echo "FINAL CONTAINS DO MIRROR URLS"; exit 1; else echo "final bundle: no DO mirror URL (PRODUCTION_MIRRORS [])"; fi
cmp -s "$O/baseline.host-policy.bundle.mjs" "$O/final.host-policy.bundle.mjs" && echo "metal host-policy bundle unchanged" || echo "metal host-policy bundle CHANGED (shared lease-reader source; default behaviour unchanged)"
echo "== 4. existing tests (unchanged) on the final source"
set +e; node --test --test-concurrency=1 --test-reporter=tap test/host-admission-runtime.test.mjs test/windows-node-platform-policy.test.mjs test/lease-reader.test.mjs > "$O/existing.tap" 2>&1; erc=$?; set -e
grep -E "^# (tests|pass|fail|skipped|cancelled)" "$O/existing.tap"; echo "existing-rc=$erc"
echo "== 5. focused new tests: final bundle + final source"
set +e; ADMISSION_MODULE="$O/final.host-admission.bundle.mjs" LEASE_READER="$T/network/lease-reader.mjs" node --test --test-concurrency=1 --test-reporter=tap test/final-fix/admission-retry.test.mjs > "$O/new.tap" 2>&1; nrc=$?; set -e
grep -E "^(not )?ok [0-9]+ |^# (pass|fail|skipped)" "$O/new.tap"; echo "new-rc=$nrc"
cd "$F"; rm -rf "$T" "$V"
[ "$erc" = 0 ] && [ "$nrc" = 0 ] && grep -q "^# fail 0" "$O/new.tap" && [ "$VFAIL" = 2 ] && echo FINAL-OK || { echo FINAL-NOT-OK; exit 1; }
