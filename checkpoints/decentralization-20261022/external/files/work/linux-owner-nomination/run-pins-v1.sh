#!/usr/bin/env bash
# (immutable; v1) the three suites whose text pins run-v3 showed my change breaks (pins updated to the reviewed form),
# and hosted-MCP (its one failure is pre-existing on baseline too): every remaining failure must be pre-existing.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export GIT_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git
cd "$here/tree"
out=$(mktemp); trap 'rm -f "$out"' EXIT
node --test --test-concurrency=1 test/metal-lease-gas-conduit.test.mjs test/metal-measured-control.test.mjs test/mcp-hosted-control.test.mjs > "$out" 2>&1 || true
grep -E "^# (pass|fail|skipped) " "$out" | tr '\n' ' '; echo
grep -E "^not ok " "$out" | sed -E 's/^not ok [0-9]+ - //' | sort > "$here/pins-failures.txt" || true
cat "$here/pins-failures.txt"
new=$(comm -23 "$here/pins-failures.txt" "$here/baseline-failures.txt")
[ -z "$new" ] || { echo "NEW FAILURES: $new"; grep -A25 "^not ok" "$out" | head -80; echo "run-pins-v1: FAIL"; exit 1; }
echo "run-pins-v1: PASS (remaining failures are pre-existing on baseline)"
