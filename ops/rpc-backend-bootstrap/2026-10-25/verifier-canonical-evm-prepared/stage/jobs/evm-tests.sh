#!/usr/bin/env bash
# REAL Node + REAL revm EVM tests for EIP-1898 hash reads (call / estimate_gas / create_access_list) on committed eeffcc9 +
# the FROZEN canonical candidate 41667ec9 + evm-tests.patch (one new test file). Offline, one compiler, --locked; no skip
# or ignored test can pass (jobs/check_cargo_output.py). Root, from work/rpc-production-final-20261025 (q-exit-status.sh NAME MIB CMD...):
#   ./jobs/q-exit-status.sh canonical-evm-tests 2560 unshare -rn bash verifier-canonical-evm-stage/jobs/evm-tests.sh
# Exit: 0 PASS; 21 CLOSURE failure; 22 DEV-CACHE-MISSING; 23 CACHE-REUSE-REFUSED; 20 COMPILE failure (21/22/23/20 are never
# verdicts); 30 INCOMPLETE (ignored/filtered/missing); 1 FAIL. Phase A is `cargo build --tests --keep-going`: every
# helios-core test target's compile errors in one run; any error still fails.
. "$(dirname "$0")/common.sh"
CHK="python3 $S/jobs/check_cargo_output.py"
X=$S/run/evm-tests-$(date -u +%Y%m%dT%H%M%SZ); prepare $X 1; cd $X/helios; closure_check $X
echo "== A: compile preflight, every helios-core target (a failure here is a COMPILE failure, never a test result)"
timeout -k 10 5400 cargo build --offline --locked -p helios-core --tests --keep-going || { echo "RESULT: COMPILE-FAILURE (not a test verdict)"; exit 20; }
echo "== B: the named EVM tests in node_evm_canonical, all ok, 0 ignored/filtered (no --include-ignored)"
timeout -k 10 1800 cargo test --offline --locked -p helios-core $TESTS -- --test-threads=1 > $X/b.out 2>&1; b=$?; cat $X/b.out
$CHK named $X/b.out <(grep -v '^#' $S/EXPECTED-CONTROLS-EVM.txt); bn=$?
echo "== C: regression: every helios-core test (incl. the 35 canonical tests and the new EVM tests); 0 failed AND 0 ignored"
timeout -k 10 3600 cargo test --offline --locked -p helios-core -- --test-threads=1 > $X/c.out 2>&1; c=$?; cat $X/c.out
$CHK regression $X/c.out; cr=$?
lock_unchanged $X
echo "RESULT: B cargo=$b named=$bn | C cargo=$c regression=$cr (3=INCOMPLETE)"
[ $b = 0 ] && [ $bn = 0 ] && [ $c = 0 ] && [ $cr = 0 ] && { echo "RESULT: PASS"; exit 0; }
[ $bn = 3 ] || [ $cr = 3 ] && { echo "RESULT: INCOMPLETE (never a pass)"; exit 30; }
echo "RESULT: FAIL"; exit 1
