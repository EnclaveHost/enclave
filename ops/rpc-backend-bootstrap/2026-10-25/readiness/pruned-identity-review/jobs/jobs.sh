#!/bin/bash
# Offline (unshare -rn, loopback only) regression for the pruned-genesis identity change. Shared queue --mib 256.
set -u
cd "$(dirname "$0")"
ip link set lo up
export PYTHONDONTWRITEBYTECODE=1 TEST_TMP="$PWD/tmp" TMPDIR="$PWD/tmp" ORIGIN_EXTRACT=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source/ops/rpc-backend-bootstrap/2026-10-25/coverage/origin_extract.py
sha256sum orig/readiness_sampler.py patched/readiness_sampler.py patched/test_readiness_sampler.py /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source/ops/rpc-backend-bootstrap/2026-10-25/coverage/origin_extract.py
rc=0
echo "=== full suite, patched"; (cd patched && timeout -k 5 600 python3 -m unittest -v test_readiness_sampler 2>&1) || rc=1
echo "=== baseline: ORIGINAL sampler b15b77af + new tests (pruned-ready and null-genesis behaviour MUST fail: 2 failures)"
rm -rf tmp/baseline && mkdir -p tmp/baseline && cp orig/readiness_sampler.py patched/test_readiness_sampler.py tmp/baseline/
(cd tmp/baseline && timeout -k 5 300 python3 -m unittest test_readiness_sampler.TestPrunedIdentity.test_pruned_l1_and_base_genesis_compensated_ready_only_with_coverage test_readiness_sampler.TestPrunedIdentity.test_null_genesis_is_incomplete_not_accepted > ../baseline.out 2>&1); b=$?
tail -3 tmp/baseline.out
if [ $b -ne 0 ] && grep -q "^FAILED (failures=2)$" tmp/baseline.out && ! grep -q "errors=" tmp/baseline.out; then echo "BASELINE KILLED"; else echo "BASELINE NOT KILLED"; rc=1; fi
echo "=== mutants"; python3 mutants.py || rc=1
exit $rc
