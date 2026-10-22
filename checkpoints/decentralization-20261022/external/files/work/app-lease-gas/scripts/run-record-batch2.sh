#!/usr/bin/env bash
# Completion of record-after (stopped by the shared memory guard: host below its floor, exit 99) - only what did not run,
# plus the two credit-vault owner tests rewritten to state the reviewed binding locally (a behavioural control on main):
#   python3 ../claude-test-queue.py --mib 512 --log ABS_LOG -- bash scripts/run-record-batch2.sh > OUT 2>&1
set -u
cd "$(dirname "$0")/.."
fail=0
run() { echo "=== STEP $*"; "$@"; local e=$?; echo "=== EXIT $e: $*"; [ $e -ne 0 ] && fail=1; return 0; }
echo "=== CONTROL (expected to fail on unmodified main)"
( cd control-cv-main && node --test --test-concurrency=1 --test-name-pattern "credit-vault owner|not every contract is a credit vault" test/lease-gas-owner-cli.test.mjs; echo "=== CONTROL EXIT $?" )
( cd overlay-main
  run node scripts/build-windows-lease-runtime.mjs
  run node --test --test-concurrency=1 --test-name-pattern "credit-vault owner|not every contract is a credit vault" test/lease-gas-owner-cli.test.mjs
  run node --test --test-concurrency=1 test/lease-relay-release.test.mjs test/lease-relay-resilience.test.mjs test/lease-relay-service.test.mjs \
    test/windows-lease-closure.test.mjs test/windows-current-runtime.test.mjs
  for n in 1 2; do rm -rf "../relay-release-$n"; run node scripts/build-lease-relay-release.mjs "../relay-release-$n"; done
  exit $fail ) || fail=1
run cmp relay-release-1/lease-relay.mjs relay-release-2/lease-relay.mjs
run cmp relay-release-1/manifest.json relay-release-2/manifest.json
run node --test --test-concurrency=1 test/linux-image-closure.test.mjs
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
