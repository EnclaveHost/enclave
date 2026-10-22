#!/usr/bin/env bash
# ONE queued job (512 MiB). Re-run of the artifact smoke only (v1 harness bug: two identical owner signatures = a correct
# 409 replay refusal). Bundles unchanged: run/fixed (2a903c36, argv-guard fix), run/new (e7a4fc1d, candidate), run/old (6e2f81cf).
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-20261021/platform-bundle-smoke
export TMPDIR=$H/tmp; rm -rf "$TMPDIR"; mkdir -p "$TMPDIR"
date -u +%FT%TZ > "$H/smoke-v2-started.utc"
sha256sum "$H"/run/*/opt/metal/platform-api.bundle.mjs "$H"/run/*/opt/metal/fixtures/tpm-roots.pem "$H/harness/bundle-smoke.test.mjs"
cd "$H/harness"
set +e
for v in fixed new old; do BUNDLE_DIR="$H/run/$v/opt/metal" node --test --test-concurrency=1 --test-reporter=tap bundle-smoke.test.mjs > "$H/v2-$v.tap" 2>&1; echo "$v-rc=$?"; done
set -e
for v in fixed new old; do echo "== $v"; grep -E "^(not )?ok [0-9]+ |^# (tests|pass|fail|skipped|cancelled)" "$H/v2-$v.tap"; done
date -u +%FT%TZ > "$H/smoke-v2-finished.utc"
grep -q "^# pass 6" "$H/v2-fixed.tap" && grep -q "^# fail 0" "$H/v2-fixed.tap" && grep -q "^# skipped 0" "$H/v2-fixed.tap" || { echo "FIXED BUNDLE FAILED"; exit 1; }
for v in new old; do grep -q "^# pass 6" "$H/v2-$v.tap" && { echo "NEGATIVE CONTROL $v DID NOT FAIL"; exit 1; }; done
echo SMOKE-V2-OK
