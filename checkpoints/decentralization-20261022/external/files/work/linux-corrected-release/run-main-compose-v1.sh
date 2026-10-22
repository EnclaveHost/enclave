#!/usr/bin/env bash
# ONE targeted composition run (immutable; v1), SOURCE ONLY, against a scratch copy of CURRENT main (main-compose-check/,
# not part of the narrow release): the Linux resume regression test (with both evidence inputs: production's own
# supervisor from dist-sdshield-2857356cd and the frozen unrepaired candidate), the private frontend live-edit and
# frontends suites, and the claim gate. Input hashes: main-compose-inputs.txt.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
W=/home/steven/Documents/Codex/2026-10-18/wo/work
cd "$here/main-compose-check"
node --check supervisor.js
out=$(mktemp); trap 'rm -f "$out"' EXIT
PROD_SUPERVISOR="$here/main-compose-check/.prod-2857356cd/supervisor.js" \
FROZEN_CANDIDATE_SUPERVISOR="$W/linux-lease-root-release/tree/supervisor.js" \
  node --test --test-concurrency=1 test/isolation-resume-shield-model.test.mjs > "$out" 2>&1 || { cat "$out"; echo "run-main-compose-v1: FAIL (resume)"; exit 1; }
cat "$out"
grep -q '^# skipped 0$' "$out" && grep -q '^# fail 0$' "$out" || { echo "run-main-compose-v1: FAIL (an evidence test was skipped)"; exit 1; }
node --test --test-concurrency=1 test/private-app-live-edit.test.mjs test/private-app-frontends.test.mjs test/isolation-claim-gate.test.mjs
echo "run-main-compose-v1: PASS"
