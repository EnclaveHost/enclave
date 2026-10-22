#!/usr/bin/env bash
# The existing suites that exercise the changed modules (lease client, shared runtime, conduit, Windows config check,
# measured control, the host relay role and its REAL platform-policy gate), unchanged, in the candidate tree, one at a
# time. Multiprocess (anvil + relay children): ONE job at 768 MiB through the shared queue:
#   python3 ../claude-test-queue.py --mib 768 --log logs/regression.guard.log -- bash run-regression.sh logs/regression.log
set -u
cd "$(dirname "$0")/tree"
LOG=${1:?log}; exec > "../$LOG" 2>&1
export GIT_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git   # scoped read-only history for the suites that read it
SUITES="test/metal-lease-gas-conduit.test.mjs test/metal-measured-control.test.mjs test/lease-gas-runtime.test.mjs test/lease-relay-policy.test.mjs
 test/windows-lease-closure.test.mjs test/lease-authorization-nonce.test.mjs test/lease-client-durability.test.mjs test/lease-consumed-own-receipt.test.mjs
 test/lease-designated-relays.test.mjs test/lease-executor-e2e.test.mjs test/lease-host-relay.test.mjs test/windows-host-app-funded.test.mjs
 test/windows-current-runtime.test.mjs test/lease-resolve-domain.test.mjs test/lease-authority.test.mjs test/lease-relay-host-policy.test.mjs
 test/lease-relay-service.test.mjs test/relay-security.test.mjs test/windows-release-journal.test.mjs test/lease-relay-migration.test.mjs"
fails=0
for s in $SUITES; do
  echo "##### $s"
  node --test --test-concurrency=1 "$s"; e=$?
  echo "##### $s EXIT $e"; [ $e -eq 0 ] || fails=$((fails + 1))
done
echo "=== SUITES FAILED: $fails"; exit $fails
