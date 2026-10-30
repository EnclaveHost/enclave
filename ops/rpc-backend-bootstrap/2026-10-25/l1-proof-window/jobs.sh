#!/bin/bash
# Offline regression for the L1 proof-window patch (claude-test-queue.py --mib 256; unshare -rn).
set -u
cd "$(dirname "$0")"
export TEST_TMP="$PWD/tmp"
export REAL_SNAPSHOT_MANIFEST=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-download-tuning/snapshot-manifest-observed.json
rc=0
echo "=== patched test_chain_service.py"; python3 -I patched/test_chain_service.py -v 2>&1 || rc=1
echo "=== patched test_coverage_activation.py"; OPS_SOURCE=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source/ops/rpc-backend-bootstrap/2026-10-25 CHAIN_SERVICE=$PWD/patched/chain_service.py python3 -I patched/test_coverage_activation.py -v 2>&1 || rc=1
echo "=== mutant: pre-patch chain_service 713b0ddf with new tests (L1 proof test MUST fail)"
python3 -I mutant/test_chain_service.py -v PruneProfileTests.test_l1_serves_proofs_at_finalized PruneProfileTests.test_base_proof_window_unchanged > mutant.out 2>&1; m=$?
cat mutant.out
# verbose unittest prints the startup JSON between the test name and its verdict, so match the summary lines.
if [ $m -ne 0 ] && grep -q '^FAIL: test_l1_serves_proofs_at_finalized' mutant.out && ! grep -q '^\(FAIL\|ERROR\): test_base_proof_window_unchanged' mutant.out \
   && grep -q '^Ran 2 tests' mutant.out && grep -q '^FAILED (failures=1)$' mutant.out; then echo "MUTANT KILLED"; else echo "MUTANT SURVIVED"; rc=1; fi
exit $rc
