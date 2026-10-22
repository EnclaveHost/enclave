#!/usr/bin/env bash
# ONE queued job (1024 MiB). DISCRIMINATION control for the smoke's critical tests: the argv-guard-fixed packaging, but with
# relay/api-relay.js and relay/secrets.js from candidate cf00054a (before the ENS-CORS and exists-fastpath changes). Expected:
# tests 1, 2 and 4 pass (packaging, start, owner gate) while 3 (CORS), 5 and 6 (exists under custody stall/failure) FAIL.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; R=$W/resume-20261021; H=$R/platform-bundle-smoke; S=$H/tree
export GIT_OPTIONAL_LOCKS=0 TMPDIR=$H/tmp
rm -rf "$S" "$TMPDIR" "$H/control-out"; mkdir -p "$TMPDIR"
cp -a "$R/reconciled-candidate" "$S"
for nm in node_modules relay/node_modules sdk/sessions/node_modules network/node_modules e2e/node_modules; do cp -a "$W/enclave/$nm" "$S/$nm"; done
cp -a "$H/fix/b/." "$S/"; cp -a "$H/control-src/." "$S/"
cd "$S"
node relay/build-network.mjs > /dev/null
node scripts/build-platform-api-guest-bundle.mjs --out "$H/control-out"
node --check "$H/control-out/platform-api.bundle.mjs"
mkdir -p "$H/run/control/opt/metal/fixtures"; cp "$H/control-out/platform-api.bundle.mjs" "$H/run/control/opt/metal/"; cp relay/fixtures/tpm-roots.pem "$H/run/control/opt/metal/fixtures/"
cd "$H/harness"
set +e; BUNDLE_DIR="$H/run/control/opt/metal" node --test --test-concurrency=1 --test-reporter=tap bundle-smoke.test.mjs > "$H/control.tap" 2>&1; echo "control-rc=$?"; set -e
grep -E "^(not )?ok [0-9]+ |^# (tests|pass|fail|skipped|cancelled)" "$H/control.tap"
sha256sum "$H/control-out/platform-api.bundle.mjs"
rm -rf "$S"
for n in 1 2 4; do grep -q "^ok $n " "$H/control.tap" || { echo "control: test $n should pass"; exit 1; }; done
for n in 3 5 6; do grep -q "^not ok $n " "$H/control.tap" || { echo "control: test $n should FAIL"; exit 1; }; done
echo CONTROL-DISCRIMINATES
