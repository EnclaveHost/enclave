#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/tree"
fail=0
run() { echo "=== STEP $*"; "$@"; local e=$?; echo "=== EXIT $e: $*"; [ $e -ne 0 ] && fail=1; return 0; }
run node scripts/build-windows-lease-runtime.mjs
run node --test --test-concurrency=1 test/lease-designated-relays.test.mjs test/lease-host-relay.test.mjs test/service-index.test.mjs \
  test/lease-relay-release.test.mjs test/lease-relay-service.test.mjs test/lease-relay-resilience.test.mjs test/lease-gas-runtime.test.mjs \
  test/windows-current-runtime.test.mjs test/windows-lease-closure.test.mjs test/windows-node-wallet-policy.test.mjs test/supervisor-image-closure.test.mjs \
  test/lease-authority.test.mjs test/lease-executor-e2e.test.mjs
run node scripts/build-lease-relay-host-package.mjs ../stage/pkg-a
run node scripts/build-lease-relay-host-package.mjs ../stage/pkg-b
run cmp ../stage/pkg-a/lease-relay.package.json ../stage/pkg-b/lease-relay.package.json
run cmp ../stage/pkg-a/lease-relay.mjs ../stage/pkg-b/lease-relay.mjs
run node scripts/build-lease-relay-host-package.mjs ../stage/pkg-a --check
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"; exit $fail
