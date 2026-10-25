#!/bin/bash
# STEP 2 (root, OFFLINE, compiles base-consensus-providers + base-consensus-cli test binaries only).
# Run: python3 work/claude-test-queue.py --mib 1536 --log $W/logs/test-offline.guard -- unshare -rn bash $W/jobs/test-offline.sh
# Pass criteria: patched suites rc 0 (all chain_provider + l1 tests); control rc != 0 with EXACTLY the four root-check
# tests failing (omitted/altered/reordered receipts, transactions root) and everything else passing.
set -uo pipefail
. "$(dirname "$0")/env.sh"
ip link set lo up 2>/dev/null || true
rc=0
cd "$BUILD/src"
echo "## patched providers"; cargo test --offline --locked -p base-consensus-providers --lib chain_provider:: -- --test-threads=2; r=$?; echo "## rc=$r"; [ $r = 0 ] || rc=1
echo "## patched cli l1"; cargo test --offline --locked -p base-consensus-cli --lib l1:: -- --test-threads=2; r=$?; echo "## rc=$r"; [ $r = 0 ] || rc=1
cd "$BUILD/src-control"
echo "## CONTROL providers (verification disabled; failures expected)"
out=$(cargo test --offline --locked -p base-consensus-providers --lib chain_provider:: -- --test-threads=2 2>&1); r=$?; echo "$out"
fails=$(echo "$out" | sed -n 's/^    chain_provider::tests::\([a-z_]*\)$/\1/p' | sort | tr '\n' ' ')
want="altered_log_is_refused omitted_receipt_is_refused_and_not_cached reordered_receipts_are_refused transactions_must_match_the_verified_transactions_root "
echo "## control rc=$r failing: $fails"
if [ $r = 0 ] || [ "$fails" != "$want" ]; then echo "## CONTROL DID NOT FAIL AS EXPECTED"; rc=1; else echo "## control failed exactly as expected"; fi
echo "## aggregate rc=$rc"; exit $rc
