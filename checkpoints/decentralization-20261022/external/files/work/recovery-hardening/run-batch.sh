#!/usr/bin/env bash
# Recovery hardening candidate (tree/ = current main + the candidate files), ONE shared-queue admission:
#   python3 ../claude-test-queue.py --mib 512 --log ABS_LOG -- bash run-batch.sh > OUT 2>&1
set -u
cd "$(dirname "$0")/tree"
fail=0
run() { echo "=== STEP $*"; "$@"; local e=$?; echo "=== EXIT $e: $*"; [ $e -ne 0 ] && fail=1; return 0; }
run node scripts/build-windows-lease-runtime.mjs          # the Windows host takes the journal from this bundle
run node --test --test-concurrency=1 test/lease-consumed-own-receipt.test.mjs test/lease-release-journal-windows.test.mjs test/windows-node-wallet-policy.test.mjs \
  test/windows-release-journal.test.mjs test/windows-current-runtime.test.mjs test/windows-lease-closure.test.mjs \
  test/host-policy-enforcement.test.mjs test/host-policy-callsites.test.mjs test/windows-shield-startup.test.mjs \
  test/lease-relay-release.test.mjs test/lease-relay-resilience.test.mjs test/lease-client-durability.test.mjs \
  test/relay-security.test.mjs test/lease-executor-e2e.test.mjs test/lease-authority.test.mjs test/lease-resolve-domain.test.mjs
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
