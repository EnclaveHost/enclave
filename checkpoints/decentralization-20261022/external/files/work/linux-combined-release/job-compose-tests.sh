#!/usr/bin/env bash
# (immutable; v1) focused composition tests on ACTUAL main (work/enclave) after the regeneration: owner nomination journal +
# config, platform-api-config, measured-control, lease-gas conduit, pinned-relay config. Tree hashes before/after prove the
# tests wrote nothing into main.
set -uo pipefail
M=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave; here="$(cd "$(dirname "$0")" && pwd)"
cd "$M"
treehash() { find . \( -name node_modules -o -name .git \) -prune -o -type f -print0 | sort -z | xargs -0 sha256sum; }
treehash > "$here/tests-before.tree.sha256"
out=$(mktemp)
node --test --test-concurrency=1 test/owner-nomination-journal.test.mjs test/owner-nomination-config.test.mjs test/platform-api-config.test.mjs \
  test/metal-measured-control.test.mjs test/metal-lease-gas-conduit.test.mjs test/lease-pinned-relay-config.test.mjs > "$out" 2>&1; rc=$?
grep -E "^# (tests|pass|fail|skipped) " "$out" | tr '\n' ' '; echo
grep -E "^not ok " "$out" || true
[ $rc -eq 0 ] || grep -B2 -A30 "^not ok" "$out" | head -120
cp "$out" "$here/logs/compose-tests-v1.tap"; rm -f "$out"
treehash > "$here/tests-after.tree.sha256"
cmp -s "$here/tests-before.tree.sha256" "$here/tests-after.tree.sha256" && echo "MAIN-UNCHANGED-BY-TESTS" || { echo "main changed during the tests:"; diff "$here/tests-before.tree.sha256" "$here/tests-after.tree.sha256" | head; }
echo "COMPOSE-TESTS rc=$rc"; exit $rc
