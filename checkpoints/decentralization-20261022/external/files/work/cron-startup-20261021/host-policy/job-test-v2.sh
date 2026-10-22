#!/usr/bin/env bash
# v2: the DIAGNOSTICS-ONLY correction (fix2: lease-reader + host-admission-runtime, no cache); v1 tested the withdrawn cache.
# ONE queued job (512 MiB). Build the host-admission bundle from main + the isolated patch in a scratch tree (no edit of
# main), then run harness/admission-quorum.test.mjs against: the DEPLOYED bundle (7ce23a55), main's unpatched bundle, and the
# PATCHED bundle; plus the existing host-admission-runtime tests on the patched source. Mock RPCs on loopback only.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; H=$W/cron-startup-20261021/host-policy; S=$H/build/tree
export TMPDIR=$H/tmp; rm -rf "$H/build" "$TMPDIR"; mkdir -p "$TMPDIR" "$H/build/out"
date -u +%FT%TZ > "$H/test-started.utc"
rsync -a --exclude .git --exclude node_modules "$W/enclave/" "$S/"
for nm in node_modules network/node_modules relay/node_modules sdk/sessions/node_modules e2e/node_modules; do [ -d "$W/enclave/$nm" ] && ln -s "$W/enclave/$nm" "$S/$nm"; done
cd "$S"
set +e; node scripts/build-host-admission.mjs --check > "$H/build/main-check.out" 2>&1; echo "main bundles current vs main source: rc=$?"; set -e
node scripts/build-host-admission.mjs; cp windows/node/host-admission.bundle.mjs "$H/build/out/main-unpatched.bundle.mjs"; cp metal/guest/host-policy.bundle.mjs "$H/build/out/main-unpatched.host-policy.bundle.mjs"
cp "$H/fix2/b/network/host-admission-runtime.mjs" network/host-admission-runtime.mjs; cp "$H/fix2/b/network/lease-reader.mjs" network/lease-reader.mjs
node scripts/build-host-admission.mjs; cp windows/node/host-admission.bundle.mjs "$H/build/out/patched.bundle.mjs"; cp metal/guest/host-policy.bundle.mjs "$H/build/out/patched.host-policy.bundle.mjs"
node --check "$H/build/out/patched.bundle.mjs"
sha256sum "$H/build/out/"* "$H/harness/deployed-7ce23a55.bundle.mjs"
cmp -s "$H/build/out/main-unpatched.host-policy.bundle.mjs" "$H/build/out/patched.host-policy.bundle.mjs" && echo "metal host-policy bundle UNCHANGED by the patch" || echo "metal host-policy bundle CHANGED by the patch"
echo "== existing tests on the patched source"
set +e; node --test --test-concurrency=1 --test-reporter=tap test/host-admission-runtime.test.mjs test/windows-node-platform-policy.test.mjs test/lease-reader.test.mjs > "$H/existing.tap" 2>&1; erc=$?; set -e
grep -E "^# (tests|pass|fail|skipped|cancelled)" "$H/existing.tap"; echo "existing-rc=$erc"
cd "$H/harness"
for v in deployed:"$H/harness/deployed-7ce23a55.bundle.mjs" main:"$H/build/out/main-unpatched.bundle.mjs" patched:"$H/build/out/patched.bundle.mjs"; do
  n=${v%%:*}; f=${v#*:}
  set +e; ADMISSION_MODULE="$f" node --test --test-concurrency=1 --test-reporter=tap admission-quorum.test.mjs > "$H/$n.tap" 2>&1; rc=$?; set -e
  echo "== $n rc=$rc"; grep -E "^(not )?ok [0-9]+ |^# METRIC|^# (pass|fail|skipped)" "$H/$n.tap"
done
date -u +%FT%TZ > "$H/test-finished.utc"
rm -rf "$S"
grep -q "^# fail 0" "$H/patched.tap" && grep -q "^# skipped 0" "$H/patched.tap" && [ "$erc" = 0 ] && echo PATCHED-OK || { echo PATCHED-NOT-OK; exit 1; }
