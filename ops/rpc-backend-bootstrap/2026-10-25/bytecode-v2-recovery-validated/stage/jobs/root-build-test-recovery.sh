#!/bin/bash
# Bytecode-checker RECEIPT v2 native build + test (bytecode-v2-validation; derived from bytecode-native-validation/jobs/root-build-test.sh:
# same steps, 23 named tests, 17 exact controls). OFFLINE, ONE compiler/linker job. NOT run by Claude. Root only:
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1792 --log $S/logs/root-build-test.guard -- unshare -rn bash $S/jobs/root-build-test.sh
# Optional, separate later lane (release binary for a live run; NOT a test):  RELEASE=1 ... --mib 2560 ...
# A compile error, a lock change, a FRESH artifact or a control that does not fail EXACTLY as listed is INVALID, never a pass.
set -uo pipefail
. "$(dirname "$0")/env.sh"
ip link set lo up 2>/dev/null || true
L=$S/logs; rc=0; T=$B/tree; M=$T/etc/tools/base-bytecode-check
die() { echo "## INVALID: $*"; echo "## aggregate rc=1"; exit 1; }
sha() { sha256sum "$1" | cut -c1-64; }
echo "## toolchain $(rustc --version) | $(cargo --version) | jobs=$CARGO_BUILD_JOBS"
[ "$(rustc --version | cut -d' ' -f2)" = 1.96.0 ] || die "toolchain is not 1.96.0"
bash "$S/jobs/recovery-precheck.sh" || die "RECOVERY: precheck refused (original evidence, product sources or derivations differ)"
[ ! -e "$B" ] || die "$B exists (owned by this stage): move it aside for a clean run (never reused)"
(cd "$S" && sha256sum -c --quiet inputs/STAGE-SHA256SUMS) || die "stage inputs differ from inputs/STAGE-SHA256SUMS"
[ "$(git -C "$BASE_REPO" rev-parse HEAD)" = "$BASE_REV" ] || die "base repo not at $BASE_REV"
mkdir -p "$T" "$CARGO_HOME/registry" "$TMPDIR" || die "mkdir failed"
git -C "$BASE_REPO" archive "$BASE_REV" | tar -x -C "$T" || die "git archive | tar failed"
[ "$(sha "$T/Cargo.lock")" = "$BASE_LOCK_SHA" ] || die "archived Cargo.lock is not the pinned one"
[ ! -e "$M" ] || die "member path already exists in the archive"
cp -r "$S/crate" "$M" || die "member copy"
python3 -I "$S/jobs/insert_lock_entry.py" "$T/Cargo.lock" || die "lock entry insertion"
LOCK1=$(sha "$T/Cargo.lock")
# private CARGO_HOME: index + .crate cache + git db/checkouts COPIED (registry/src is NOT copied: cargo re-extracts the
# needed .crate files, each sha256-checked against the lock by verify_inputs.py below)
cp -r "$SRC_CARGO_HOME/registry/index" "$SRC_CARGO_HOME/registry/cache" "$CARGO_HOME/registry/" && cp -r "$SRC_CARGO_HOME/git" "$CARGO_HOME/" || die "cargo home copy"
python3 -I "$S/jobs/verify_inputs.py" "$T/Cargo.lock" "$CARGO_HOME" "$L/closure-manifest.json" || die "closure inputs differ from the lock"
cmp -s "$L/closure-manifest.json" "$S/inputs/closure-manifest.json" || die "closure manifest differs from the prepared inputs/closure-manifest.json"
[ -d "$O/build/target/debug" ] && [ ! -e "$CARGO_TARGET_DIR" ] || die "RECOVERY: original target missing or recovery target exists"
cp -a --reflink=auto "$O/build/target" "$CARGO_TARGET_DIR" || die "RECOVERY: target copy failed"
echo "## RECOVERY: reusing a COPY of the ended original target for dependencies only (original untouched); the member test binary must still be REBUILT"
cd "$T" || die "no tree"
echo "## [0] resolution only (no compile): cargo tree --locked"
cargo tree --offline --locked -p base-bytecode-check -e normal,build,dev --prefix none --format '{p}' > "$L/cargo-tree.txt" 2> "$L/cargo-tree.err" \
  || die "BLOCKER: --locked resolution failed (lock entry or feature activation differs): $(tail -5 "$L/cargo-tree.err")"
[ "$(sha Cargo.lock)" = "$LOCK1" ] || die "cargo changed Cargo.lock"
python3 -I - "$L/cargo-tree.txt" "$L/closure-manifest.json" <<'PY' || die "compiled graph is not inside the verified closure"
import json, re, sys
c = {(p['name'], p['version']) for p in json.load(open(sys.argv[2]))['packages']}
got = set()
for l in open(sys.argv[1]):
    m = re.match(r'(\S+) v(\S+)', l.strip())
    if m and m.group(1) != 'base-bytecode-check': got.add((m.group(1), m.group(2)))
extra = sorted(got - c); print(f'## compiled graph: {len(got)} packages, all inside the verified closure of {len(c)}' if not extra else f'outside: {extra}')
sys.exit(1 if extra else 0)
PY
TESTS="client_cross_check_independently_refuses_harmful_rows client_panics_exactly_where_the_checker_predicts client_written_rows_are_canonical_and_agree \
completeness_counts_missing_code_and_ignores_empty digests_change_with_one_row_one_byte_or_one_reference extra_table_bytes_and_bits_past_bit_len_are_non_canonical_not_failures \
forged_jump_bits_are_executed_by_the_client framed_digest_is_stable_and_length_and_count_framed mdbx_scan_end_to_end_reports_failures_missing_code_and_is_read_only \
missing_code_bad_row_and_empty_accounts_are_not_ok missing_or_partial_checkpoints_are_not_ok mutation_between_scans_changes_txn_id_entries_and_digests \
nonzero_padding_is_executed_by_the_client padding_shorter_than_revm42_is_refused_and_dupn_is_classified pseudo_random_client_rows_pass_and_every_read_jump_bit_flip_fails \
raw_tag0_rows_follow_new_raw read_errors_and_absent_databases_are_never_ok report_ok_requires_every_v2_binding \
rows_the_client_misreads_silently_are_refused size_key_and_length_guards v2_json_has_exactly_the_a2_schema \
v2_scan_leaves_every_byte_of_mdbx_dat_unchanged v2_scan_valid_fixture_is_ok_with_exact_counts_digests_and_checkpoints"
build() { # <label>: build the lib test binary, require REBUILT, set EXE/EXESHA
  cargo test --offline --locked -p base-bytecode-check --lib --no-run --message-format=json > "$L/$1.build.json" 2> "$L/$1.build.err" \
    || die "$1: test build FAILED (a compile error is not a valid result): $(grep -m5 -E '^error' "$L/$1.build.err")"
  j=$(python3 -I "$S/jobs/artifact.py" base_bytecode_check < "$L/$1.build.json") || die "$1: artifact not found"
  set -- $j; [ "$1" = rebuilt ] || die "Cargo reports the test binary FRESH (not recompiled)"
  EXE=$2; EXESHA=$(sha "$EXE"); [ "$(sha "$T/Cargo.lock")" = "$LOCK1" ] || die "cargo changed Cargo.lock"; }
echo "## [1] patched (RECOVERY: product lib.rs/main.rs/Cargo.toml unchanged; fixture-only tests.rs f1bd5c1c): build + run all tests"
build patched; P=$EXESHA; echo "## patched test binary sha256 $P"
"$EXE" --test-threads=2 > "$L/patched.test.out" 2>&1; R=$?
grep -E '^test |^test result' "$L/patched.test.out"
[ $R = 0 ] && grep -q '^test result: ok\. 23 passed; 0 failed' "$L/patched.test.out" || { echo "## patched FAILED (rc=$R)"; rc=1; }
for t in $TESTS; do grep -q "^test tests::$t \.\.\. ok$" "$L/patched.test.out" || { echo "## test missing or not ok: $t"; rc=1; }; done
ORIG=$(sha "$M/src/lib.rs"); cp "$M/src/lib.rs" "$B/lib.rs.orig"
for c in jumpbit padding client completeness eip7702 entries accounts codele withcode txnid checkpoints datadir rowsdigest refsdigest framing count scanned; do
  echo "## [2] CONTROL $c (one rule disabled)"
  WANT=$(python3 -I "$S/control/disable_check.py" $c "$M/src/lib.rs") || die "control $c preparation"
  build control-$c; [ "$EXESHA" != "$P" ] || die "control $c binary == patched binary: the control did not run"
  "$EXE" --test-threads=2 > "$L/control-$c.test.out" 2>&1; R=$?
  GOT=$(sed -n 's/^    \(tests::[a-z0-9_]*\)$/\1/p' "$L/control-$c.test.out" | sort -u | tr '\n' ' ' | sed 's/ $//')
  grep -qE '^error|panicked at .*(SIGSEGV|abort)' "$L/control-$c.test.out" && { echo "## control $c: abnormal output"; rc=1; }
  echo "## control $c rc=$R failing: $GOT"
  [ $R = 101 ] && [ "$GOT" = "$WANT" ] && echo "## control $c failed exactly as expected" || { echo "## control $c DID NOT FAIL AS EXPECTED (want: $WANT)"; rc=1; }
  cp "$B/lib.rs.orig" "$M/src/lib.rs"; [ "$(sha "$M/src/lib.rs")" = "$ORIG" ] || die "lib.rs not restored"
done
if [ "${RELEASE:-0}" = 1 ]; then
  echo "## [3] release binary (live-run candidate; thin-LTO cu16 from the workspace profile)"
  cargo build --offline --locked --release -p base-bytecode-check --bin base-bytecode-check --message-format=json > "$L/release.build.json" 2> "$L/release.build.err" || die "release build FAILED"
  BIN=$(python3 -I -c "import json,sys;h=[m['executable'] for m in map(json.loads,sys.stdin) if m.get('reason')=='compiler-artifact' and m['target']['name']=='base-bytecode-check' and m.get('executable')];print(h[-1] if len(h)==1 else '')" < "$L/release.build.json")
  [ -n "$BIN" ] || die "release artifact not found"; echo "## release binary $BIN sha256 $(sha "$BIN") (source lib.rs $ORIG)"
fi
[ "$(sha "$T/Cargo.lock")" = "$LOCK1" ] || die "cargo changed Cargo.lock"
echo "## aggregate rc=$rc"; exit $rc
