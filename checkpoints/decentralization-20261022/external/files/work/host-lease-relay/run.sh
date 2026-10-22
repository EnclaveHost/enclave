#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/tree"
fail=0
run() { echo "=== STEP $*"; "$@"; local e=$?; echo "=== EXIT $e: $*"; [ $e -ne 0 ] && fail=1; return 0; }
run node scripts/build-windows-lease-runtime.mjs
run node --test --test-concurrency=1 test/lease-host-relay.test.mjs test/lease-relay-release.test.mjs test/lease-relay-service.test.mjs test/lease-relay-resilience.test.mjs \
  test/lease-gas-runtime.test.mjs test/windows-current-runtime.test.mjs test/windows-lease-closure.test.mjs test/lease-authority.test.mjs test/lease-executor-e2e.test.mjs
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"; exit $fail
