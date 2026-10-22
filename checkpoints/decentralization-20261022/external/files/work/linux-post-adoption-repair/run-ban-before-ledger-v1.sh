#!/usr/bin/env bash
# (immutable; v1) The explicit-refusal-before-ledger case only (root review 2026-10-21): the lifecycle regression
# (isolation-post-adoption-lease, 9 timelines) on
#  1. tree/ (frozen 51516b778 + the repair, now with the refusal-aware silence): all 9 pass, none skipped;
#  2. root's byte-frozen prior copy tree/.root-review-prior-supervisor.js (read only): EXACTLY the 4 new refusal-before-
#     ledger timelines fail (fresh ban, persisted ban, deregistration, transient-then-ban); the other 5 pass;
#  3. main-tree/ (current main + the repair): all 9 pass.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out=$(mktemp); trap 'rm -f "$out"' EXIT
tally() { grep -E "^# (pass|fail|skipped) " "$out" | tr '\n' ' '; echo; }
all9() { grep -qx '# pass 9' "$out" && grep -qx '# fail 0' "$out" && grep -qx '# skipped 0' "$out"; }
echo "=== 1 tree/, repaired"
cd "$here/tree"; node --check supervisor.js
node --test --test-concurrency=1 test/isolation-post-adoption-lease.test.mjs > "$out" 2>&1 || { cat "$out"; echo "run-ban-before-ledger-v1: FAIL (1)"; exit 1; }
tally; all9 || { cat "$out"; echo "run-ban-before-ledger-v1: FAIL (1 counts)"; exit 1; }
echo "=== 2 root's prior copy (must fail exactly the refusal-before-ledger timelines)"
[ "$(sha256sum .root-review-prior-supervisor.js | cut -d' ' -f1)" = 3f0b9eec3bb4198e21bd04d442ebbac8fc686835d57bd7d8e3c06723abb5d237 ] || { echo "prior copy changed"; exit 1; }
rc=0; SUPERVISOR_UNDER_TEST=.root-review-prior-supervisor.js node --test --test-concurrency=1 test/isolation-post-adoption-lease.test.mjs > "$out" 2>&1 || rc=$?
tally; grep -E "^(not )?ok " "$out"
[ "$rc" -ne 0 ] && grep -qx '# pass 5' "$out" && grep -qx '# fail 4' "$out" \
  && [ "$(grep -cE '^not ok .*(at a cold boot whose ledger never answers: the guests still end|transient first, then the refusal becomes known)' "$out")" = 4 ] \
  || { cat "$out"; echo "run-ban-before-ledger-v1: FAIL (2: the prior copy did not fail exactly as expected)"; exit 1; }
echo "=== 3 main-tree/, composition"
cd "$here/main-tree"; node --check supervisor.js
node --test --test-concurrency=1 test/isolation-post-adoption-lease.test.mjs > "$out" 2>&1 || { cat "$out"; echo "run-ban-before-ledger-v1: FAIL (3)"; exit 1; }
tally; all9 || { cat "$out"; echo "run-ban-before-ledger-v1: FAIL (3 counts)"; exit 1; }
echo "run-ban-before-ledger-v1: PASS"
