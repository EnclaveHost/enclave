#!/bin/bash
# Root re-run after the accepted test-only fix (.get('code') in the two downgrade assertions; sampler unchanged).
# root-tests-2003 failed rc 1: suite 89/89 OK, baseline + m1/m2/m4/m5 KILLED, m3 caught only by KeyError (errors=2).
# Refuses unless the exact reviewed bytes are present, then runs the UNCHANGED jobs.sh (full suite, old baseline,
# all five mutants) and additionally requires exactly 89 suite tests and 5 KILLED mutants. Run inside unshare -rn.
set -u
cd "$(dirname "$0")"
pin() { [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$2" ] || { echo "PIN MISMATCH $1"; exit 2; }; }
pin orig/readiness_sampler.py b15b77afa653ee70439596d1a6aa6b8b4add0371e0a6d01eb506e276c114cec8
pin patched/readiness_sampler.py 9aa80ab8a2cbe156f513349f44366c4ad2c8588539666ac802ed9015c771d055
pin patched/test_readiness_sampler.py 10c88fa2618b43f793e49ce62b59e3c35d7c99fd5dc992a5afde9750e80bdf72
pin /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source/ops/rpc-backend-bootstrap/2026-10-25/readiness/readiness_sampler.py 9aa80ab8a2cbe156f513349f44366c4ad2c8588539666ac802ed9015c771d055
pin /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source/ops/rpc-backend-bootstrap/2026-10-25/readiness/test_readiness_sampler.py 10c88fa2618b43f793e49ce62b59e3c35d7c99fd5dc992a5afde9750e80bdf72
pin jobs.sh 723788b1ed29727d9e0f817c75681e83467b4c9a0f9da3b71fc95fc64f0ad84b
pin mutants.py e4edfdd09e738dfc57247beb585c4934a1bba056743dfc54f53c0a050c6ad902
echo "pins OK"
mkdir -p tmp
./jobs.sh 2>&1 | tee tmp/rerun-jobs.out; rc=${PIPESTATUS[0]}
grep -q '^Ran 89 tests' tmp/rerun-jobs.out || { echo "SUITE COUNT IS NOT 89"; rc=1; }
grep -q '^BASELINE KILLED$' tmp/rerun-jobs.out || { echo "BASELINE NOT KILLED"; rc=1; }
[ "$(grep -cE '^m[1-5]-[a-z-]+: KILLED ' tmp/rerun-jobs.out)" = 5 ] || { echo "NOT ALL 5 MUTANTS KILLED"; rc=1; }
echo "rerun rc=$rc"
exit $rc
