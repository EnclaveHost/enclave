#!/usr/bin/env bash
# Domain-review batch (root 2026-10-20 P1/P2 + relay RPC resilience), serially inside ONE shared-queue admission:
#   python3 ../claude-test-queue.py --mib 768 --log ABS_LOG -- bash scripts/run-overlay-batch.sh [steps...] > OUT 2>&1
#   overlay   - main's permanent tests touched by the fixes + the ported new ones, in overlay-main/ (main + candidate files,
#               scripts/build-main-overlay.sh), after regenerating that tree's Windows bundle with main's builder
#   overlay-fixes - only the overlay tests updated after a first run (see the step)
#   closure   - the Linux image closure alone
#   bundle    - regenerate the candidate's Windows bundle (shadow-win) from the shared runtime
#   candidate - candidate-only layouts: Linux image closure, the bundle freshness check, the real Windows heartbeat
#   supervisor- the ACTUAL Linux supervisor candidate suite (relays and the shared resolver changed)
set -u
cd "$(dirname "$0")/.."
steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(overlay bundle candidate supervisor)
fail=0
run() { echo "=== STEP $*"; "$@"; local e=$?; echo "=== EXIT $e: $*"; [ $e -ne 0 ] && fail=1; return 0; }
for s in "${steps[@]}"; do
  case "$s" in
    overlay)
      ( cd overlay-main
        run node scripts/build-windows-lease-runtime.mjs
        run node --test --test-concurrency=1 test/lease-resolve-domain.test.mjs test/lease-relay-resilience.test.mjs test/lease-relay-service.test.mjs \
          test/lease-relay-release.test.mjs test/lease-gas-cost-model.test.mjs test/make-deployment-record.test.mjs test/lease-gas-owner-cli.test.mjs \
          test/lease-executor-e2e.test.mjs test/lease-client-durability.test.mjs test/relay-security.test.mjs test/lease-authority.test.mjs \
          test/lease-gas-runtime.test.mjs test/supervisor-image-closure.test.mjs
        run node --test --test-concurrency=1 test/windows-release-journal.test.mjs test/windows-current-runtime.test.mjs test/windows-lease-closure.test.mjs \
          test/windows-host-app-funded.test.mjs test/windows-control-activation.test.mjs
        exit $fail ) || fail=1 ;;
    overlay-fixes)
      # the two overlay files updated after domain1 (lease-authority's send seam, Windows test 7's held reason)
      ( cd overlay-main
        run node scripts/build-windows-lease-runtime.mjs
        run node --test --test-concurrency=1 test/lease-authority.test.mjs test/windows-release-journal.test.mjs
        exit $fail ) || fail=1 ;;
    closure)
      run node --test --test-concurrency=1 test/linux-image-closure.test.mjs ;;
    bundle)
      run node scripts/build-windows-lease-runtime.mjs ;;
    candidate)
      run node --test --test-concurrency=1 test/linux-image-closure.test.mjs
      run node scripts/build-windows-lease-runtime.mjs --check
      run node --import ./test/helpers/windows-heartbeat-candidate.mjs --test --test-concurrency=1 --test-name-pattern "REAL Windows node" \
        ../enclave/test/offchain-heartbeat-writers.test.mjs ;;
    supervisor)
      run node --test --test-concurrency=1 test/supervisor-current-runtime.test.mjs ;;
    *) echo "unknown step $s"; fail=1 ;;
  esac
done
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
