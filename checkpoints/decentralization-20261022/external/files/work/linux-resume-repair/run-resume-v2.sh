#!/usr/bin/env bash
# Shield-model resume repair (immutable; v2 = v1 on BOTH trees): the repaired frozen candidate (tree/) and a scratch copy
# of CURRENT main with resume-repair.main.patch (main-tree/). In each: the new regression test with both evidence
# inputs (production's own supervisor, dist-sdshield-2857356cd /app/supervisor.js; the frozen unrepaired candidate),
# asserting neither evidence test was skipped; then that tree's existing claim-gate and guest-pool suites.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out=$(mktemp); trap 'rm -f "$out"' EXIT
for t in tree main-tree; do
  echo "=== $t"
  cd "$here/$t"
  node --check supervisor.js
  PROD_SUPERVISOR="$here/$t/.prod-2857356cd/supervisor.js" \
  FROZEN_CANDIDATE_SUPERVISOR="$here/../linux-lease-root-release/tree/supervisor.js" \
    node --test --test-concurrency=1 test/isolation-resume-shield-model.test.mjs > "$out" 2>&1 || { cat "$out"; echo "run-resume-v2: FAIL ($t new test)"; exit 1; }
  cat "$out"
  grep -q '^# skipped 0$' "$out" && grep -q '^# fail 0$' "$out" || { echo "run-resume-v2: FAIL ($t: an evidence test was skipped or failed)"; exit 1; }
  node --test --test-concurrency=1 test/isolation-claim-gate.test.mjs test/isolation-guest-pool.test.mjs
done
echo "run-resume-v2: PASS"
