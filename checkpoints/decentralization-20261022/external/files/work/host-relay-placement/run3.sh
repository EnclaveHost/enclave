#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/tree"
fail=0
run() { echo "=== STEP $*"; "$@"; local e=$?; echo "=== EXIT $e: $*"; [ $e -ne 0 ] && fail=1; return 0; }
run node scripts/build-windows-lease-runtime.mjs
run node --test --test-concurrency=1 test/lease-designated-relays.test.mjs test/lease-gas-runtime.test.mjs test/windows-current-runtime.test.mjs test/windows-lease-closure.test.mjs
# the one run2 failure that was environmental (the tree is not a git checkout): read-only history from main's repository
run env GIT_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git node --test --test-name-pattern "independent checker qualifies a community provider" test/service-index.test.mjs
run node scripts/build-lease-relay-host-package.mjs ../stage/pkg-a --check
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"; exit $fail
