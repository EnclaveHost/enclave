#!/usr/bin/env bash
# Shield-model resume repair (immutable; v1), focused: the new regression test with BOTH evidence inputs (production's
# own supervisor, image dist-sdshield-2857356cd /app/supervisor.js; the frozen unrepaired candidate), asserting neither
# evidence test was skipped; then the two existing suites over the same functions (claim gate, guest pool).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/tree"
node --check supervisor.js
out=$(mktemp); trap 'rm -f "$out"' EXIT
PROD_SUPERVISOR="$here/tree/.prod-2857356cd/supervisor.js" \
FROZEN_CANDIDATE_SUPERVISOR="$here/../linux-lease-root-release/tree/supervisor.js" \
  node --test --test-concurrency=1 test/isolation-resume-shield-model.test.mjs > "$out" 2>&1 || { cat "$out"; echo "run-resume-v1: FAIL (new test)"; exit 1; }
cat "$out"
grep -q '^# skipped 0$' "$out" && grep -q '^# fail 0$' "$out" || { echo "run-resume-v1: FAIL (an evidence test was skipped or failed)"; exit 1; }
node --test --test-concurrency=1 test/isolation-claim-gate.test.mjs test/isolation-guest-pool.test.mjs
echo "run-resume-v1: PASS"
