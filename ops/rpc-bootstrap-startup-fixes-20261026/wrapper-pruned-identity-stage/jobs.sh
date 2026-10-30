#!/bin/bash
# Offline (unshare -Urn, no network) tests of the wrapper pruned-identity overlay against r12-final wrapper 4fc3b970.
set -u -o pipefail
cd "$(dirname "$0")"
export PYTHONDONTWRITEBYTECODE=1 TMPDIR="$PWD/tmp"
sha256sum orig/chain_service.py overlay/wrapper/chain_service.py overlay/wrapper/test_l1_pruned_identity.py ref/test_chain_service.py mutants.py
rc=0
rm -rf tmp/patched tmp/baseline && mkdir -p tmp/patched tmp/baseline
cp overlay/wrapper/chain_service.py overlay/wrapper/test_l1_pruned_identity.py ref/test_chain_service.py tmp/patched/
cp orig/chain_service.py overlay/wrapper/test_l1_pruned_identity.py ref/test_chain_service.py tmp/baseline/
echo "=== patched: existing wrapper suite (unmodified, sha 541342a4) + pruned identity suite"
(cd tmp/patched && timeout -k 5 600 python3 -m unittest -v test_chain_service test_l1_pruned_identity 2>&1) || rc=1
echo "=== baseline: ORIGINAL r12 wrapper, existing suite must pass"
(cd tmp/baseline && timeout -k 5 600 python3 -m unittest test_chain_service 2>&1 | tail -3) || rc=1
echo "=== baseline: ORIGINAL r12 wrapper must REFUSE the live pruned refusal (blocker reproduced)"
(cd tmp/baseline && timeout -k 5 300 python3 -m unittest test_l1_pruned_identity.PrunedIdentityTests.test_live_pruned_refusal_ready_on_compensated_basis > ../baseline.out 2>&1); b=$?
grep -m1 "AssertionError" tmp/baseline.out; tail -1 tmp/baseline.out
if [ $b -ne 0 ] && grep -q "AssertionError: local RPC failed" tmp/baseline.out; then echo "BASELINE REPRODUCES BLOCKER"; else echo "BASELINE DID NOT REPRODUCE"; rc=1; fi
echo "=== mutants"; timeout -k 5 1200 python3 mutants.py || rc=1
echo "rc=$rc"; exit $rc
