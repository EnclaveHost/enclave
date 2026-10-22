#!/usr/bin/env bash
# Round-3 verification batch, run serially inside ONE shared-queue admission (cwd work/app-lease-gas):
#   python3 ../claude-test-queue.py --mib 768 --log ABS_LOG -- bash scripts/run-r3-batch.sh [steps...]
# Steps (default: all): bundle shared windows linuxmain supervisor
#   bundle    - regenerate the Windows bundle from the shared runtime (after a shared-code change)
#   supervisor- the ACTUAL Linux supervisor candidate suite (test/supervisor-current-runtime.test.mjs)
#   shared    - the shared client/runtime/relay/authority tests, the Linux image closure, the relay service
#   windows   - the Windows bundle freshness check, actual chain module, closure/cold load, actual Windows heartbeat
#   linuxmain - main's own durable release tests (move-release-durable/-restart) against the Linux CANDIDATE with
#               app-funded leases UNCONFIGURED (the operator-paid path must be exactly main's)
set -u
cd "$(dirname "$0")/.."
steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(bundle shared windows linuxmain supervisor)
fail=0
run() { echo "=== STEP $*"; "$@"; local e=$?; echo "=== EXIT $e: $*"; [ $e -ne 0 ] && fail=1; return 0; }
for s in "${steps[@]}"; do
  case "$s" in
    bundle)
      run node scripts/build-windows-lease-runtime.mjs ;;
    supervisor)
      run node --test --test-concurrency=1 test/supervisor-current-runtime.test.mjs ;;
    shared)
      run node --test --test-concurrency=1 test/lease-gas-cost-model.test.mjs test/make-deployment-record.test.mjs test/lease-executor-e2e.test.mjs test/lease-gas-owner-cli.test.mjs test/lease-client-durability.test.mjs test/linux-image-closure.test.mjs test/lease-relay-service.test.mjs test/lease-gas-runtime.test.mjs \
        test/relay-security.test.mjs test/lease-authority.test.mjs ;;
    windows)
      run node scripts/build-windows-lease-runtime.mjs --check
      run node --test --test-concurrency=1 test/windows-current-runtime.test.mjs test/windows-lease-closure.test.mjs test/windows-host-app-funded.test.mjs test/windows-release-journal.test.mjs
      run node --import ./test/helpers/windows-heartbeat-candidate.mjs --test --test-concurrency=1 --test-name-pattern "REAL Windows node" \
        ../enclave/test/offchain-heartbeat-writers.test.mjs ;;
    linuxmain)
      ( cd ../enclave && MOVE_TEST_SUPERVISOR="$PWD/../app-lease-gas/shadow-b/supervisor.js" run node --test --test-concurrency=1 \
          test/move-release-durable.test.mjs test/move-release-restart.test.mjs; exit $fail ) || fail=1 ;;
    *) echo "unknown step $s"; fail=1 ;;
  esac
done
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
