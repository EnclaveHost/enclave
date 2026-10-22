#!/usr/bin/env bash
# (immutable; v5) root review: the re-broadcast's queue-slot boundary. The journal suite (actual module, fixture RPC,
# gated operator queue) against (1) the repaired module: all pass, none skipped; (2) the preserved previous module
# aa682cda... (.host-owner-nomination.v2-aa682cda.mjs): EXACTLY the new queue-delay case fails, every other case passes.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; cd "$here/tree"
out=$(mktemp); trap 'rm -f "$out"' EXIT
fail() { echo "run-v5: FAIL ($1)"; exit 1; }
[ "$(sha256sum < network/.host-owner-nomination.v2-aa682cda.mjs | cut -c1-64)" = "$(sha256sum < ../host-owner-nomination.v2-aa682cda.mjs | cut -c1-64)" ] || fail "v2 copy"
node --check network/host-owner-nomination.mjs || fail syntax
echo "=== 1 repaired module"
node --test --test-concurrency=1 test/owner-nomination-journal.test.mjs > "$out" 2>&1 || { cat "$out"; fail "repaired"; }
grep -E "^# (pass|fail|skipped) " "$out" | tr '\n' ' '; echo
grep -qx '# pass 6' "$out" && grep -qx '# fail 0' "$out" && grep -qx '# skipped 0' "$out" || { cat "$out"; fail "repaired counts"; }
echo "=== 2 the previous module aa682cda (must fail exactly the queue-delay case)"
NOMINATOR_MODULE=../network/.host-owner-nomination.v2-aa682cda.mjs node --test --test-concurrency=1 test/owner-nomination-journal.test.mjs > "$out" 2>&1 && fail "the previous module passed the queue-delay case"
grep -E "^# (pass|fail|skipped) |^(not )?ok " "$out"
grep -qx '# pass 5' "$out" && grep -qx '# fail 1' "$out" && grep -qE '^not ok .* - queue delay: ' "$out" || { cat "$out"; fail "previous module counts"; }
grep -E "nothing broadcast" "$out" | head -2 | cut -c1-200
echo "run-v5: PASS"
