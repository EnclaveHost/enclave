#!/usr/bin/env bash
# ONE queued job (512 MiB). The attestation wire-route proposal (route-compat.patch) against the candidate's OWN tests:
# NEGATIVE CONTROL = the candidate as it is (the brand-rewritten route); then the same tests with the patch applied.
# Scratch copy of bundle-refresh/tree (candidate + real node_modules + generated network-runtime). The candidate is untouched.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-20261021; H=$W/route-compat; S=$H/tree
export TMPDIR=$H/tmp; rm -rf "$S" "$TMPDIR"; mkdir -p "$TMPDIR"
cp -a "$W/bundle-refresh/tree" "$S"; cd "$S"
TESTS="test/relay-u7-eligible-routing.test.mjs test/cli-attest-verifier.test.mjs"
echo "== negative control: candidate as is"
set +e; node --test --test-concurrency=1 --test-reporter=tap $TESTS > "$H/control.out" 2>&1; crc=$?; set -e
grep -E "^# (tests|pass|fail|skipped|cancelled)|^not ok" "$H/control.out" || true
grep -E "^ +(error|expected|actual):" "$H/control.out" | head -12 || true
echo "control-rc=$crc"
echo "== patched: route-compat.patch"
patch -p1 --fuzz=0 < "$H/route-compat.patch"
set +e; node --test --test-concurrency=1 --test-reporter=tap $TESTS > "$H/patched.out" 2>&1; prc=$?; set -e
grep -E "^# (tests|pass|fail|skipped|cancelled)|^not ok" "$H/patched.out" || true
echo "patched-rc=$prc"
[ "$prc" = 0 ] && grep -q "^# skipped 0" "$H/patched.out" && grep -q "^# fail 0" "$H/patched.out"
[ "$crc" != 0 ] || { echo "NEGATIVE CONTROL DID NOT FAIL: the test does not discriminate"; exit 1; }
echo ROUTE-COMPAT-OK
