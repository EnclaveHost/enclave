#!/usr/bin/env bash
# ONE queued job (512 MiB). The artifact-level smoke (harness/bundle-smoke.test.mjs) against the ACTUAL generated bundle
# (run/new, e7a4fc1d = candidate 6163e2e7), then the SAME harness against the previous candidate bundle (run/old,
# 6e2f81cf = candidate 7990461e, built before the CORS and exists fixes) as the negative control.
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-20261021/platform-bundle-smoke
export TMPDIR=$H/tmp; rm -rf "$TMPDIR"; mkdir -p "$TMPDIR"
date -u +%FT%TZ > "$H/started.utc"
sha256sum "$H"/run/*/opt/metal/platform-api.bundle.mjs "$H"/run/*/opt/metal/fixtures/tpm-roots.pem "$H/harness/bundle-smoke.test.mjs"
cd "$H/harness"
set +e
BUNDLE_DIR="$H/run/new/opt/metal" node --test --test-concurrency=1 --test-reporter=tap bundle-smoke.test.mjs > "$H/new.tap" 2>&1; nrc=$?
BUNDLE_DIR="$H/run/old/opt/metal" node --test --test-concurrency=1 --test-reporter=tap bundle-smoke.test.mjs > "$H/old.tap" 2>&1; orc=$?
set -e
for v in new old; do echo "== $v"; grep -E "^(not )?ok [0-9]+ |^# (tests|pass|fail|skipped|cancelled)" "$H/$v.tap"; done
date -u +%FT%TZ > "$H/finished.utc"
echo "new-rc=$nrc old-rc=$orc"
[ "$nrc" = 0 ] && grep -q "^# skipped 0" "$H/new.tap" && grep -q "^# fail 0" "$H/new.tap" || { echo "NEW BUNDLE FAILED"; exit 1; }
[ "$orc" != 0 ] || { echo "NEGATIVE CONTROL DID NOT FAIL"; exit 1; }
echo SMOKE-OK
