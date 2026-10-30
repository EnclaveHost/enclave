#!/bin/bash
# M10 root foreground job (OFFLINE). NOT run by Claude. After root's production M7 build has finished:
#   python3 work/claude-test-queue.py --mib 1792 --log $M/logs/root-test-m10.guard -- unshare -rn bash $M/jobs/root-test-m10.sh
# Step 0 builds PRIVATE inputs: tree/ = git archive 5476069f + M7 (sha-checked) + M10 (sha-checked, git apply --check), control/ =
# tree/ with ONLY the two anchor precondition checks disabled; a private CARGO_HOME COPIED (never linked/written) from the M7 one.
# Each phase: cargo clean -p <crate> in the PRIVATE target, build tests with --no-run --message-format=json, assert from Cargo's own
# artifact record that the test binary was REBUILT (fresh=false; the M7 r2 alias failure), record its sha256, run exactly it.
# Pass: engine lib 100% incl. sync::anchor (6) + core bootstrap_anchor (4); node lib actors::engine:: (processor 3 + validator 1),
#       sequencer refusal (1), service::anchor_safedb (3), actors::derivation:: regression; cli node:: incl. bootstrap_anchor_flag (3);
#       every named M10 test must appear as "ok"; CONTROL engine fails EXACTLY WANT_E, CONTROL node fails EXACTLY WANT_N;
#       each control binary != its patched binary.
set -uo pipefail
. "$(dirname "$0")/env.sh"
ip link set lo up 2>/dev/null || true
H=$M/jobs; L=$M/logs; rc=0
die() { echo "## INVALID: $*"; echo "## aggregate rc=1"; exit 1; }
sha() { sha256sum "$1" | cut -c1-64; }
echo "## toolchain $(rustc --version) | $(cargo --version)"
[ ! -e "$B" ] || die "$B exists (owned by this stage): remove it for a clean run"
[ "$(git -C "$BASE_REPO" rev-parse HEAD)" = "$BASE_REV" ] || die "base repo not at $BASE_REV"
[ "$(sha $M/inputs/base-l1-verify.patch)" = "$M7_PATCH_SHA" ] || die "M7 patch sha mismatch"
[ "$(sha $M/m10-bootstrap-anchor.patch)" = "$(cut -c1-64 $M/m10-bootstrap-anchor.patch.sha256)" ] || die "M10 patch sha mismatch"
mkdir -p "$B/tree" "$CARGO_HOME" "$L" || die "mkdir failed"
git -C "$BASE_REPO" archive "$BASE_REV" | tar -x -C "$B/tree" || die "git archive | tar failed"
[ -f "$B/tree/Cargo.toml" ] && [ -f "$B/tree/Cargo.lock" ] || die "archive incomplete"
(cd "$B/tree" && git apply --check "$M/inputs/base-l1-verify.patch" && git apply "$M/inputs/base-l1-verify.patch" && git apply --check "$M/m10-bootstrap-anchor.patch" && git apply "$M/m10-bootstrap-anchor.patch") || die "patches do not apply"
cp -a "$B/tree" "$B/control" && python3 -I "$M/control/disable-anchor-checks.py" "$B/control" || die "control preparation"
[ "$(diff -r "$B/tree" "$B/control" | grep -c '^>')" = 3 ] || die "control differs by more than the three disabled lines"
cp -r --reflink=auto "$M7_CARGO_HOME/registry" "$M7_CARGO_HOME/git" "$CARGO_HOME/" || die "cargo home copy"
phase() { # <tree> <crate> <lib target name> <filter> <label>
  local tree=$1 crate=$2 tname=$3 filt=$4 label=$5 j
  cd "$B/$tree" || die "no $tree"
  cargo clean --offline -p "$crate" > "$L/$label.clean.out" 2>&1 || die "$label: cargo clean -p failed"
  cargo test --offline --locked -p "$crate" --lib --no-run --message-format=json > "$L/$label.build.json" 2> "$L/$label.build.err" \
    || die "$label: test build FAILED (a compile error is not a valid result): $(tail -5 "$L/$label.build.err")"
  j=$(python3 -I "$H/artifact.py" "$tname" < "$L/$label.build.json") || die "$label: artifact not found"
  set -- $j; [ "$1" = rebuilt ] || die "$label: Cargo reports the test binary FRESH (not recompiled)"
  EXE=$2; EXESHA=$(sha "$EXE"); echo "## $label: REBUILT $(basename "$EXE") sha256 $EXESHA"
  "$EXE" $filt --test-threads=2 > "$L/$label.test.out" 2>&1; R=$?
  grep -E '^test .*(anchor|bootstrap)|^test result' "$L/$label.test.out"
}
ok() { grep -q '^test result: ok\.' "$L/$1.test.out" && [ $R = 0 ] && echo "## $1 OK" || { echo "## $1 FAILED (rc=$R)"; rc=1; }; }
echo "## [1] engine lib (all tests: default paths unchanged + M10)"; phase tree base-consensus-engine base_consensus_engine "" engine; P1=$EXESHA; ok engine
ran() { for t in "$@"; do grep -q "^test .*$t \.\.\. ok$" "$L/$LBL.test.out" || { echo "## M10 test missing or not ok: $t"; rc=1; }; done; }
run_filter() { # <exe> <filter> <label>: reruns an already-built binary with another filter
  LBL=$3; "$1" $2 --test-threads=2 > "$L/$3.test.out" 2>&1; R=$?; grep -E '^test .*(anchor|bootstrap)|^test result' "$L/$3.test.out"; ok "$3"; }
LBL=engine; ran precondition_accepts_head_exactly_n_with_labels_at_or_below_n precondition_refuses_wrong_number_wrong_hash_and_rpc_claimed_hash \
  precondition_refuses_replayed_snapshot_labels_above_n precondition_propagates_execution_layer_errors anchored_forkchoice_is_head_over_n_and_requires_n_canonical \
  parse_accepts_only_number_colon_hash valid_fcu_starts_from_head_over_anchor_with_safe_finalized_at_anchor invalid_or_syncing_fcu_refuses_without_retry \
  fcu_rpc_error_refuses_without_retry anchor_not_canonical_refuses_before_any_fcu
echo "## [2] node lib (actors::engine:: incl. processor + validator anchor tests)"; phase tree base-consensus-node base_consensus_node "actors::engine::" node; P2=$EXESHA; NODE=$EXE; ok node
LBL=node; ran precondition_refuses_an_execution_head_that_was_not_unwound_to_the_anchor without_anchor_the_precondition_is_a_no_op \
  first_reset_starts_at_the_anchor_ignoring_a_replayed_label_then_clears_it anchor_precondition_failure_ends_the_actor_without_seed_state_or_fcu
echo "## [2b] node: sequencer refusal"; run_filter "$NODE" "actors::sequencer::engine_request_coordinator::" node-seq; ran sequencer_refuses_a_bootstrap_anchor_before_any_engine_call
echo "## [2c] node: anchored SafeDB wipe (real redb)"; run_filter "$NODE" "service::anchor_safedb::" node-safedb
ran real_redb_wipe_removes_snapshot_entries_persistently a_failing_reset_is_fatal a_surviving_entry_is_refused_and_disabled_is_accepted
echo "## [2d] node: derivation actor regression (unchanged SafeDB reset on pipeline reset)"; run_filter "$NODE" "actors::derivation::" node-derivation
echo "## [3] cli lib node::"; phase tree base-consensus-cli base_consensus_cli "node::" cli; ok cli
LBL=cli; ran parses_and_is_absent_without_the_flag refuses_malformed_values_and_has_no_env_binding the_embedded_sequencer_args_have_no_bootstrap_anchor_flag
control_check() { # <label> <test-path-prefix> <want>
  local f; f=$(sed -n "s/^    $2\([a-z_]*\)\$/\1/p" "$L/$1.test.out" | sort | tr '\n' ' ')
  echo "## $1 rc=$R failing: $f"
  [ $R != 0 ] && [ "$f" = "$3" ] && echo "## $1 failed exactly as expected" || { echo "## $1 DID NOT FAIL AS EXPECTED (want: $3)"; rc=1; }; }
echo "## [4] CONTROL engine (precondition checks disabled)"; phase control base-consensus-engine base_consensus_engine "sync::anchor::" control-engine
[ "$EXESHA" != "$P1" ] || die "control engine binary == patched binary: the control did not run"
control_check control-engine "sync::anchor::tests::" "precondition_refuses_replayed_snapshot_labels_above_n precondition_refuses_wrong_number_wrong_hash_and_rpc_claimed_hash "
echo "## [5] CONTROL node (SafeDB wipe reset disabled)"; phase control base-consensus-node base_consensus_node "service::anchor_safedb::" control-node
[ "$EXESHA" != "$P2" ] || die "control node binary == patched binary: the control did not run"
control_check control-node "service::anchor_safedb::tests::" "a_failing_reset_is_fatal real_redb_wipe_removes_snapshot_entries_persistently "
echo "## aggregate rc=$rc"; exit $rc
