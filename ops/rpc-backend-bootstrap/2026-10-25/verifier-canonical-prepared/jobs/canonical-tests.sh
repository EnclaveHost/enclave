#!/usr/bin/env bash
# Canonical-block tests on committed eeffcc9 + canonical-block.patch. Offline, one compiler, --locked; no skips or
# ignored tests can pass (jobs/check_cargo_output.py). Root, from work/rpc-production-final-20261025 (q-exit-status.sh NAME MIB CMD...):
#   ./jobs/q-exit-status.sh canonical-tests 2560 unshare -rn bash verifier-canonical-stage/jobs/canonical-tests.sh
# Exit: 0 PASS; 20 COMPILE/FETCH failure (not a verdict); 30 INCOMPLETE (ignored/filtered/missing); 1 FAIL.
. "$(dirname "$0")/common.sh"
CHK="python3 $S/jobs/check_cargo_output.py"
X=$S/run/tests-$(date -u +%Y%m%dT%H%M%SZ); prepare $X 1; cd $X/helios
echo "== A: compile preflight (a failure here is a COMPILE/FETCH failure, never a test result)"
timeout -k 10 5400 cargo test --offline --locked -p helios-core $TESTS --no-run || { echo "RESULT: COMPILE-FAILURE (not a test verdict)"; exit 20; }
echo "== B: the 35 named tests in exactly 5 binaries, all ok, 0 ignored/filtered (no --include-ignored)"
timeout -k 10 1800 cargo test --offline --locked -p helios-core $TESTS -- --test-threads=1 > $X/b.out 2>&1; b=$?; cat $X/b.out
$CHK named $X/b.out <(grep -v '^#' $S/EXPECTED-CONTROLS.txt); bn=$?
echo "== C: regression: every helios-core test (lib, integration incl. rpc_request_budget, doc); 0 failed AND 0 ignored"
timeout -k 10 3600 cargo test --offline --locked -p helios-core -- --test-threads=1 > $X/c.out 2>&1; c=$?; cat $X/c.out
$CHK regression $X/c.out; cr=$?
timeout -k 10 3600 cargo build --offline --locked -p helios-revm-utils; r=$?
echo "== D: the Helios CLI still builds with the patch (debug, as the pinned binary)"
timeout -k 10 5400 cargo build --offline --locked -p helios-cli --bin helios; d=$?
lock_unchanged $X
echo "RESULT: B cargo=$b named=$bn | C cargo=$c regression=$cr (3=INCOMPLETE) | revm=$r | cli=$d"
[ $b = 0 ] && [ $bn = 0 ] && [ $c = 0 ] && [ $cr = 0 ] && [ $r = 0 ] && [ $d = 0 ] && { echo "RESULT: PASS"; exit 0; }
[ $bn = 3 ] || [ $cr = 3 ] && { echo "RESULT: INCOMPLETE (never a pass)"; exit 30; }
echo "RESULT: FAIL"; exit 1
