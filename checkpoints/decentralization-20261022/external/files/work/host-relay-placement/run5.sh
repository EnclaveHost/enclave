#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/tree"
MAIN=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
fail=0
run() { echo "=== STEP $*"; "$@"; local e=$?; echo "=== EXIT $e: $*"; [ $e -ne 0 ] && fail=1; return 0; }
info() { echo "=== INFO $*"; "$@"; echo "=== INFO-EXIT $?: $*"; }
for f in supervisor.js windows/node/host.mjs windows/node/chain.mjs client/lease-executor-client.mjs network/lease-gas-runtime.mjs network/lease-relay-discovery.mjs; do run node --check "$f"; done
run node scripts/build-windows-lease-runtime.mjs
run node scripts/build-metal-lease-gas.mjs
info cmp metal/guest/lease-gas-conduit.bundle.mjs "$MAIN/metal/guest/lease-gas-conduit.bundle.mjs"
info cmp metal/guest/lease-gas-conduit.bundle.mjs.manifest.json "$MAIN/metal/guest/lease-gas-conduit.bundle.mjs.manifest.json"
run node --test --test-concurrency=1 test/metal-lease-gas-conduit.test.mjs test/supervisor-image-closure.test.mjs test/host-policy-callsites.test.mjs test/windows-host-app-funded.test.mjs
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"; exit $fail
