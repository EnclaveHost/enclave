#!/usr/bin/env bash
# The final composition, one queued job (1024 MiB):
#   tree = current main (MAIN-SNAPSHOT-2.txt) + frozen private-browser patch + live-edit acceptance patch.
#   1. the private-app suites and the patched claim-gate test on that tree, then the supervisor mutants (P1..P10);
#   2. the composed site release (same production base) -> release/<CID>, reviewed and re-verified from scratch;
#   3. site-host embeds that release; native tests, wasm32-wasip2 component, e2e in a loopback-only namespace.
set -euo pipefail
cd "$(dirname "$0")"
echo "== 1. node suites on the composed tree"
(cd tree && taskset -c 0-3 node --test --test-concurrency=1 test/private-app-live-edit.test.mjs test/private-app-frontends.test.mjs test/isolation-claim-gate.test.mjs)
echo "== 1b. supervisor mutants"
rm -rf mut
python3 mutants.py P1_handoff_query_unchecked P2_handoff_scope_dropped P3_handoff_record_rule_skipped P4_handoff_cached_chain \
  P5_handoff_path_unbound P6_bounce_ignores_owner_choice P7_access_duplicates_accepted P8_access_paths_accepted \
  P9_access_not_applied_live P10_live_edit_skips_live_options
cat mut/results.txt
if grep -qv "KILLED" mut/results.txt; then echo "a mutant SURVIVED"; exit 1; fi
test "$(grep -c KILLED mut/results.txt)" = 10
echo "== 2. composed site release"
out="$(./build-release.sh)"
echo "$out" | grep -v '^  '
cid="$(echo "$out" | sed -n 's/^site release \(b[a-z2-7]*\)$/\1/p' | tail -1)"
test -n "$cid"
REL="$PWD/release/$cid"
node tree/scripts/site-release/cli.mjs review "$REL"
node tree/scripts/site-release/cli.mjs verify "$REL"
echo "FINAL-RELEASE $cid"
echo "== 3. site-host on that release"
site-host/scripts/build-and-test-2.sh "$REL"
echo "FINAL-JOB-OK $cid"
