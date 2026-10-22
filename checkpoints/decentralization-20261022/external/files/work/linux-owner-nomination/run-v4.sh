#!/usr/bin/env bash
# (immutable; v4) root review of the nominator's journal: (1) root's reproduce.mjs UNCHANGED against the repaired module
# must now FAIL its "defect reproduced" assertion; (2) the same script pointed at the preserved reviewed module
# (d35041738...) must still reproduce BOTH findings; (3) the owner-nomination suites (journal rules with the actual module;
# config path; real contracts on anvil through the real supervisor) pass with nothing skipped.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; W=/home/steven/Documents/Codex/2026-10-18/wo/work
out=$(mktemp); trap 'rm -f "$out"' EXIT
fail() { echo "run-v4: FAIL ($1)"; exit 1; }
[ "$(sha256sum < "$here/tree/network/.host-owner-nomination.v1-d35041738.mjs" | cut -c1-64)" = d35041738ff8d7664836fab9e3bc52116f341a24705a85e5c3c3491c4b6fb608 ] || fail "v1 copy"
echo "=== 1 root's reproduce.mjs (unchanged) against the repaired module"
node "$W/owner-nomination-root-review/reproduce.mjs" > "$out" 2>&1; rc=$?
cat "$out" | head -12
[ $rc -ne 0 ] && grep -q "expected reproduction of current retry durability defect" "$out" || fail "the repaired module still behaves as the reproduction expects"
echo "=== 2 the same script against the preserved reviewed module"
node "$here/repro/reproduce-against-v1.mjs" > "$out" 2>&1 || { cat "$out"; fail "v1 reproduction"; }
cat "$out"; grep -q BOTH_REVIEW_FINDINGS_REPRODUCED "$out" || fail "v1 reproduction output"
cd "$here/tree"
for f in network/host-owner-nomination.mjs supervisor.js; do node --check "$f" || fail "syntax $f"; done
for t in test/owner-nomination-journal.test.mjs test/owner-nomination-config.test.mjs test/owner-nomination.test.mjs; do
  echo "=== 3 $t"
  node --test --test-concurrency=1 "$t" > "$out" 2>&1 || { cat "$out"; fail "$t"; }
  grep -E "^# (pass|fail|skipped) " "$out" | tr '\n' ' '; echo
  grep -qx '# fail 0' "$out" && grep -qx '# skipped 0' "$out" || { cat "$out"; fail "$t counts"; }
done
echo "run-v4: PASS"
