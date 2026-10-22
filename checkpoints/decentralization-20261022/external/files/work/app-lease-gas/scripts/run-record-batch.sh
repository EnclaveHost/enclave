#!/usr/bin/env bash
# Relay send-record validation + credit-vault owners (root reviews 2026-10-20), after the fixes, in ONE shared-queue admission:
#   python3 ../claude-test-queue.py --mib 512 --log ABS_LOG -- bash scripts/run-record-batch.sh > OUT 2>&1
# overlay-main/ = current main + this candidate's files (scripts/build-main-overlay.sh). Focused: the relay startup path
# (resilience, service), the release package (check, unit, artifact), the owner CLI (credit-vault owners) and its module's
# consumers, the Windows bundle (it carries the client and owner modules) + its runtime and closure, the Linux closure.
set -u
cd "$(dirname "$0")/.."
fail=0
run() { echo "=== STEP $*"; "$@"; local e=$?; echo "=== EXIT $e: $*"; [ $e -ne 0 ] && fail=1; return 0; }
# CONTROL (not gating): the same new tests against UNMODIFIED current main (control-cv-main/, a copy of main + these tests):
# they are expected to FAIL there - the reproduction of both findings, with every case listed
echo "=== CONTROL (expected to fail on unmodified main)"
( cd control-cv-main && node --test --test-concurrency=1 --test-name-pattern "malformed or partial send record|send record: exactly|credit-vault owner|not every contract is a credit vault" \
    test/lease-relay-resilience.test.mjs test/lease-relay-release.test.mjs test/lease-gas-owner-cli.test.mjs; echo "=== CONTROL EXIT $?" )
( cd overlay-main
  run node scripts/build-windows-lease-runtime.mjs
  run node --test --test-concurrency=1 test/lease-relay-resilience.test.mjs test/lease-relay-service.test.mjs test/lease-relay-release.test.mjs \
    test/lease-gas-owner-cli.test.mjs test/lease-gas-cost-model.test.mjs test/lease-gas-runtime.test.mjs test/windows-lease-closure.test.mjs test/windows-current-runtime.test.mjs
  # the lease relay release artifact, built twice from this tree into fresh directories: it must be reproducible
  for n in 1 2; do rm -rf "../relay-release-$n"; run node scripts/build-lease-relay-release.mjs "../relay-release-$n"; done
  exit $fail ) || fail=1
run cmp relay-release-1/lease-relay.mjs relay-release-2/lease-relay.mjs
run cmp relay-release-1/manifest.json relay-release-2/manifest.json
run node --test --test-concurrency=1 test/linux-image-closure.test.mjs
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
