#!/bin/bash
# RELEASE-ONLY build of base-bytecode-check (OFFLINE, --locked, -j1, linker threads 1). NOT run by Claude. Root only:
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2560 --log $S/release/logs/root-release.guard -- unshare -rn bash $S/release/root-release.sh > $S/release/root-release.out 2>&1
# Reuses the VERIFIED private build/ of root-bytecode-native-2202 (tree, cargo-home, target) without changing any of it
# except adding target/release. Workspace thin-LTO release profile used UNCHANGED (no CARGO_PROFILE_RELEASE_* override).
# Produces a live-run CANDIDATE only: not a test, no DB access, OPEN_GAPS unchanged.
set -uo pipefail
. "$(dirname "$0")/../jobs/env.sh"          # frozen settings: CARGO_HOME/TARGET/TMPDIR, toolchain 1.96.0, CARGO_BUILD_JOBS=1
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
RL=$S/release/logs; T=$B/tree; M=$T/etc/tools/base-bytecode-check
die() { echo "## INVALID: $*"; echo "## release rc=1"; exit 1; }
sha() { sha256sum "$1" | cut -c1-64; }
STAGE_SUMS_SHA=9effed77cfdc2b3dd68dd4c645fab1e96bd302bcd41a17c9927e8c274ac4699d
LIB_SHA=739c3245b51f4a465a34bd95276b711a39131d3e11588d99d062fef932ab43a1
LOCK_SHA=91a9e7626b5f361faed8f5226268ffae177970575e8ecd243d09cb077bd23bab
RUSTC_V='rustc 1.96.0 (ac68faa20 2026-05-25)'; CARGO_V='cargo 1.96.0 (30a34c682 2026-05-25)'
[ ! -e "$RL" ] || die "$RL exists: a release run already happened (move it aside; never reused)"
mkdir -p "$RL" || die mkdir
exec > >(tee "$RL/release.log") 2>&1
echo "## [0] pins"
[ "$(rustc --version)" = "$RUSTC_V" ] && [ "$(cargo --version)" = "$CARGO_V" ] || die "toolchain differs: $(rustc --version) | $(cargo --version)"
env | grep -q '^CARGO_PROFILE_RELEASE' && die "a CARGO_PROFILE_RELEASE_* override is set: the workspace profile must be used unchanged"
[ -z "${RUSTFLAGS:-}${CARGO_ENCODED_RUSTFLAGS:-}" ] || die "RUSTFLAGS already set"
[ "$(sha "$S/inputs/STAGE-SHA256SUMS")" = "$STAGE_SUMS_SHA" ] && (cd "$S" && sha256sum -c --quiet inputs/STAGE-SHA256SUMS) || die "stage inputs changed"
(cd "$P" && sha256sum -c --quiet "$S/release/PASSED-TEST-RECEIPTS.sha256") || die "passed test receipts changed"
grep -q '^## aggregate rc=0$' "$P/logs/root-bytecode-native-2202.out" && [ "$(cat "$P/logs/root-bytecode-native-2202.rc")" = 0 ] || die "the pinned test run is not a pass"
[ "$(git -C "$BASE_REPO" rev-parse HEAD)" = "$BASE_REV" ] || die "base repo not at $BASE_REV"
[ "$(sha "$M/src/lib.rs")" = "$LIB_SHA" ] && [ "$(sha "$B/lib.rs.orig")" = "$LIB_SHA" ] || die "member lib.rs is not the original (controls not restored?)"
diff -r "$S/crate" "$M" > /dev/null || die "member in build/tree differs from crate/"
[ "$(sha "$T/Cargo.lock")" = "$LOCK_SHA" ] || die "Cargo.lock differs from the tested one"
# tree == git archive 5476069f except Cargo.lock (one inserted entry); tar --compare reads without extracting
git -C "$BASE_REPO" archive "$BASE_REV" | tar -d -C "$T" > "$RL/tree-compare.txt" 2>&1
grep -vE '^Cargo.lock: |: (Uid|Gid) differs$' "$RL/tree-compare.txt" | grep -q . && die "build/tree differs from git archive $BASE_REV beyond Cargo.lock: $(head -3 "$RL/tree-compare.txt")"
[ ! -e "$CARGO_TARGET_DIR/release" ] || die "pre-existing $CARGO_TARGET_DIR/release: refusing (a fresh, non-reused artifact is required)"
python3 -I "$S/jobs/verify_inputs.py" "$T/Cargo.lock" "$CARGO_HOME" "$RL/closure-manifest.json" > /dev/null && cmp -s "$RL/closure-manifest.json" "$S/inputs/closure-manifest.json" || die "closure inputs changed"
echo "## pins ok: stage $STAGE_SUMS_SHA lib $LIB_SHA lock $LOCK_SHA tree==archive(+lock) receipts ok"
export RUSTFLAGS='-C link-arg=-Wl,--threads=1'      # lld (the linker of the tested build: .comment "Linker: LLD 22.1.2") single-threaded
cd "$T" || die "no tree"
echo "## [1] cargo build --release (jobs=$CARGO_BUILD_JOBS, RUSTFLAGS=$RUSTFLAGS)"
cargo build --offline --locked --release -p base-bytecode-check --bin base-bytecode-check --message-format=json > "$RL/release.build.json" 2> "$RL/release.build.err" \
  || die "release build FAILED: $(grep -m5 -E '^error' "$RL/release.build.err")"
read -r FRESH BIN OPT <<< "$(python3 -I -c '
import json,sys
h=[m for m in map(json.loads,sys.stdin) if m.get("reason")=="compiler-artifact" and m["target"]["name"]=="base-bytecode-check" and "bin" in m["target"]["kind"] and m.get("executable")]
print("x x x" if len(h)!=1 else " ".join([str(h[0]["fresh"]).lower(), h[0]["executable"], str(h[0]["profile"]["opt_level"])]))' < "$RL/release.build.json")"
[ "$BIN" != x ] || die "expected exactly one release bin artifact"
[ "$FRESH" = false ] || die "Cargo reports the release binary FRESH (not built by this run)"
[ "$OPT" = 3 ] || die "release opt-level is $OPT, not the workspace's 3"
case "$BIN" in "$CARGO_TARGET_DIR/release/"*) ;; *) die "artifact outside target/release: $BIN";; esac
BSHA=$(sha "$BIN"); BSIZE=$(stat -c %s "$BIN")
readelf -p .comment "$BIN" > "$RL/release.comment.txt" 2>&1 || true
[ "$(sha "$T/Cargo.lock")" = "$LOCK_SHA" ] && [ "$(sha "$M/src/lib.rs")" = "$LIB_SHA" ] || die "cargo changed the lock or the source"
(cd "$S" && sha256sum -c --quiet inputs/STAGE-SHA256SUMS) || die "stage inputs changed during the build"
echo "## [2] usage smoke (no datadir access): no argument must be refused"
"$BIN" > "$RL/usage.out" 2>&1; U=$?; [ $U != 0 ] && grep -q 'usage: base-bytecode-check <datadir>' "$RL/usage.out" || die "usage smoke: rc=$U"
python3 -I - "$RL/release-manifest.json" <<PY || die "manifest"
import json, sys
json.dump({'format': 'base-bytecode-check-release/v1', 'artifact': '$BIN', 'sha256': '$BSHA', 'size': $BSIZE, 'fresh': False,
  'profile': 'release (workspace 5476069f: opt-level 3, lto thin, codegen-units 16, panic unwind, strip symbols; unchanged)',
  'rustflags': '$RUSTFLAGS', 'jobs': '$CARGO_BUILD_JOBS', 'rustc': '$RUSTC_V', 'cargo': '$CARGO_V', 'baseRev': '$BASE_REV',
  'cargoLockSha256': '$LOCK_SHA', 'libRsSha256': '$LIB_SHA', 'stageSumsSha256': '$STAGE_SUMS_SHA',
  'testedBy': 'logs/root-bytecode-native-2202 (13/13 + 5 exact controls; debug test profile, NOT this binary)',
  'notTested': 'this release binary on any datadir; live run under root review still required; OPEN_GAPS unchanged'}, open(sys.argv[1], 'w'), indent=1)
PY
echo "## release binary $BIN sha256 $BSHA size $BSIZE fresh=false opt=3"; cat "$RL/release.comment.txt" | sed -n 's/^ *\[ *[0-9a-f]*\] */## comment: /p'
echo "## release rc=0"
