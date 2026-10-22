#!/usr/bin/env bash
# (immutable; v1) owner nomination: the two new suites on tree/ (current main + the change), then the narrow existing
# suites over the changed files on tree/ AND on baseline/ (current main's working files, unchanged): every failure on
# tree/ must also fail on baseline/ (pre-existing), and the new suites must pass with nothing skipped.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export GIT_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git   # read-only: git show HEAD:... in one suite
SUITES="test/metal-measured-control.test.mjs test/metal-lease-gas-conduit.test.mjs test/metal-launcher-isolation.test.mjs test/metal-launcher-certs.test.mjs test/mcp-hosted-control.test.mjs test/platform-api-config.test.mjs test/direct-only-supervisor.test.mjs test/move-release-restart.test.mjs"
out=$(mktemp); trap 'rm -f "$out"' EXIT
tally() { grep -E "^# (pass|fail|skipped) " "$1" | tr '\n' ' '; echo; }
cd "$here/tree"
for f in supervisor.js metal/enclave-metal.mjs metal/guest/gsup.mjs metal/guest/measured-control.mjs metal/guest/owner-nomination.mjs network/host-owner-nomination.mjs metal/build-image.mjs; do node --check "$f"; done
python3 -m py_compile metal/overlay-control-image.py
for t in test/owner-nomination-config.test.mjs test/owner-nomination.test.mjs; do
  echo "=== new: $t"
  node --test --test-concurrency=1 "$t" > "$out" 2>&1 || { cat "$out"; echo "run-v1: FAIL ($t)"; exit 1; }
  tally "$out"; grep -qx '# fail 0' "$out" && grep -qx '# skipped 0' "$out" || { cat "$out"; echo "run-v1: FAIL ($t counts)"; exit 1; }
done
echo "=== existing suites, tree/"
rc=0; node --test --test-concurrency=1 $SUITES > "$out" 2>&1 || rc=$?
tally "$out"; grep -E "^not ok " "$out" | sed -E 's/^not ok [0-9]+ - //' | sort > "$here/tree-failures.txt" || true
grep -E "^# SKIP|# SKIP" "$out" | head -5 || true
if [ "$rc" -ne 0 ]; then
  echo "=== existing suites, baseline/ (to tell pre-existing failures)"
  cd "$here/baseline"
  node --test --test-concurrency=1 $SUITES > "$out.b" 2>&1 || true
  tally "$out.b"; grep -E "^not ok " "$out.b" | sed -E 's/^not ok [0-9]+ - //' | sort > "$here/baseline-failures.txt" || true
  rm -f "$out.b"
  new=$(comm -23 "$here/tree-failures.txt" "$here/baseline-failures.txt")
  [ -z "$new" ] || { echo "NEW FAILURES (not on baseline):"; echo "$new"; cd "$here/tree"; node --test --test-concurrency=1 $SUITES 2>&1 | grep -B2 -A30 "^not ok" | head -150; echo "run-v1: FAIL (regression)"; exit 1; }
  echo "every failure on tree/ is pre-existing on baseline/:"; cat "$here/tree-failures.txt"
fi
echo "run-v1: PASS"
