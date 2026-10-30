#!/bin/bash
# M7 test-offline, CONTROL RECOVERY harness (replaces the control flow of jobs/test-offline.sh; jobs/ and the patch are unchanged).
# Root-run, OFFLINE: python3 work/claude-test-queue.py --mib 1792 --log $W/control-recovery/logs/test-offline-r3.guard -- \
#                      unshare -rn bash $W/control-recovery/test-offline-r3.sh
# Why: r2 ran the SAME test binary (base_consensus_providers-36019c953d96440f) for patched and control. src/ and src-control/ share
# $CARGO_TARGET_DIR and the providers unit hashes identically in both trees, so Cargo judged the control fresh by mtime and never
# compiled it. Here every providers phase first runs `cargo clean -p base-consensus-providers` in the PRIVATE build/target (cached
# dependencies kept; no shared cache touched), compiles with --no-run and asserts from Cargo's own artifact message that the test
# binary was REBUILT (fresh=false), records source + binary sha256, and runs exactly that binary.
# Pass: patched providers 14/14 and CLI l1 5/5; control builds (a compile error is NOT a valid negative control) and fails EXACTLY
# the five verification tests (9 passed, 5 failed); patched again after control passes 14/14; control binary != patched binary.
set -uo pipefail
. "$(dirname "$0")/../jobs/env.sh"
ip link set lo up 2>/dev/null || true
H=$(dirname "$0"); rc=0; FILT=chain_provider::
REL=crates/consensus/providers/src/chain_provider.rs
die() { echo "## INVALID: $*"; echo "## aggregate rc=1"; exit 1; }
sha() { sha256sum "$1" | cut -c1-64; }
echo "## toolchain $(rustc --version) | $(cargo --version)"
echo "## sources: patched $(sha $BUILD/src/$REL) control $(sha $BUILD/src-control/$REL)"
[ "$(sha $BUILD/src/$REL)" != "$(sha $BUILD/src-control/$REL)" ] || die "patched and control provider sources are identical"
d=$(diff $BUILD/src/$REL $BUILD/src-control/$REL | grep -c '^>'); g=$(diff $BUILD/src/$REL $BUILD/src-control/$REL | grep '^>' | grep -c 'if false && !self.trust_rpc {')
echo "## control diff: $d changed lines, $g of them 'if false && !self.trust_rpc {'"; [ "$d" = 2 ] && [ "$g" = 2 ] || die "control differs from patched by more than the two disabled checks"
other=$(diff -rq $BUILD/src $BUILD/src-control -x target -x .git | grep -v "$REL" || true); [ -z "$other" ] || die "trees differ beyond $REL: $other"
phase() { # <tree> <label> -> sets EXE, EXESHA; prints the test output to $H/logs/<label>.test.out
  local tree=$1 label=$2 j
  cd "$BUILD/$tree" || die "no $tree"
  cargo clean --offline -p base-consensus-providers > "$H/logs/$label.clean.out" 2>&1 || die "$label: cargo clean -p failed ($(tail -2 "$H/logs/$label.clean.out"))"
  cargo test --offline --locked -p base-consensus-providers --lib --no-run --message-format=json > "$H/logs/$label.build.json" 2> "$H/logs/$label.build.err" \
    || die "$label: test build FAILED (a compile error is not a valid result): $(tail -3 "$H/logs/$label.build.err")"
  j=$(python3 -I "$H/artifact.py" < "$H/logs/$label.build.json") || die "$label: artifact not found"
  set -- $j; [ "$1" = rebuilt ] || die "$label: Cargo reports the providers test binary FRESH (not recompiled)"
  EXE=$2; EXESHA=$(sha "$EXE")
  echo "## $label: source $(sha "$BUILD/$tree/$REL") REBUILT test binary $(basename "$EXE") sha256 $EXESHA"
  "$EXE" "$FILT" --test-threads=2 > "$H/logs/$label.test.out" 2>&1; R=$?
  grep -E '^test |^test result' "$H/logs/$label.test.out"
}
echo "## [1] patched providers"; phase src patched; P1=$EXESHA
grep -q '^test result: ok. 14 passed; 0 failed' "$H/logs/patched.test.out" && [ $R = 0 ] && echo "## patched: 14/14 OK" || { echo "## patched providers FAILED (rc=$R)"; rc=1; }
echo "## [2] patched cli l1"; cd "$BUILD/src"; cargo test --offline --locked -p base-consensus-cli --lib l1:: -- --test-threads=2 > "$H/logs/cli.test.out" 2>&1; r=$?
grep -E '^test |^test result|Compiling base' "$H/logs/cli.test.out"
[ $r = 0 ] && grep -q '^test result: ok. 5 passed; 0 failed' "$H/logs/cli.test.out" && echo "## cli: 5/5 OK" || { echo "## cli FAILED (rc=$r)"; rc=1; }
echo "## [3] CONTROL providers (both verification checks disabled; five failures expected)"; phase src-control control; C1=$EXESHA
[ "$C1" != "$P1" ] && echo "## control binary differs from patched ($C1 vs $P1)" || die "control binary == patched binary: the control did not run"
fails=$(sed -n 's/^    chain_provider::tests::\([a-z_]*\)$/\1/p' "$H/logs/control.test.out" | sort | tr '\n' ' ')
want="altered_log_is_refused forged_header_cannot_vouch_for_forged_receipts omitted_receipt_is_refused_and_not_cached reordered_receipts_are_refused transactions_must_match_the_verified_transactions_root "
echo "## control rc=$R failing: $fails"
if [ $R != 0 ] && [ "$fails" = "$want" ] && grep -q '^test result: FAILED. 9 passed; 5 failed' "$H/logs/control.test.out"; then echo "## control failed exactly as expected (5 named, 9 passed)"
else echo "## CONTROL DID NOT FAIL AS EXPECTED"; rc=1; fi
echo "## [4] patched providers again (after control)"; phase src patched-again; P2=$EXESHA
grep -q '^test result: ok. 14 passed; 0 failed' "$H/logs/patched-again.test.out" && [ $R = 0 ] && echo "## patched-again: 14/14 OK" || { echo "## patched-again FAILED (rc=$R)"; rc=1; }
echo "## patched binary rebuilt identically after control: $([ "$P2" = "$P1" ] && echo yes || echo "NO ($P2) - informational")"
echo "## aggregate rc=$rc"; exit $rc
