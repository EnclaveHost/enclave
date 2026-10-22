#!/usr/bin/env bash
# ONE queued job (512 MiB). The artifact smoke, ONCE, against the FINAL integrated artifact: the platform-api bundle as it
# now sits in the reconciled candidate (tree 0e229304), laid out with the candidate's relay/fixtures/tpm-roots.pem sidecar.
set -euo pipefail
R=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-20261021; H=$R/platform-bundle-smoke; C=$R/reconciled-candidate
export TMPDIR=$H/tmp; rm -rf "$TMPDIR" "$H/run/integrated"; mkdir -p "$TMPDIR" "$H/run/integrated/opt/metal/fixtures"
cp "$C/metal/guest/platform-api.bundle.mjs" "$H/run/integrated/opt/metal/"; cp "$C/relay/fixtures/tpm-roots.pem" "$H/run/integrated/opt/metal/fixtures/"
date -u +%FT%TZ > "$H/integrated-smoke-started.utc"
sha256sum "$H/run/integrated/opt/metal/platform-api.bundle.mjs" "$H/run/integrated/opt/metal/fixtures/tpm-roots.pem" "$C/metal/guest/platform-api.bundle.mjs.manifest.json" "$H/harness/bundle-smoke.test.mjs"
cd "$H/harness"
set +e; BUNDLE_DIR="$H/run/integrated/opt/metal" node --test --test-concurrency=1 --test-reporter=tap bundle-smoke.test.mjs > "$H/integrated.tap" 2>&1; rc=$?; set -e
date -u +%FT%TZ > "$H/integrated-smoke-finished.utc"
grep -E "^(not )?ok [0-9]+ |^# (tests|pass|fail|skipped|cancelled)" "$H/integrated.tap"; echo "node-test-rc=$rc"
[ "$rc" = 0 ] && grep -q "^# pass 6" "$H/integrated.tap" && grep -q "^# fail 0" "$H/integrated.tap" && grep -q "^# skipped 0" "$H/integrated.tap"
echo INTEGRATED-SMOKE-OK
