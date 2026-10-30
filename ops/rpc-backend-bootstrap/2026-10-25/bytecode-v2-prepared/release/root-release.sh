#!/bin/bash
# RELEASE-ONLY build of base-bytecode-check RECEIPT v2 (OFFLINE, --locked, -j1, linker threads 1). PREPARED; NOT run by Claude.
# Root only, AFTER root-bytecode-v2-native-2249 has FINISHED and PASSED (the receipt check below refuses otherwise):
#   R=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/bytecode-v2-release
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2560 --log $R/root-release.guard -- unshare -rn bash $R/root-release.sh > $R/root-release.out 2>&1
# Pattern: root's reviewed v1 runner (bytecode-native-validation/release/root-release.sh). Reuses the VERIFIED private build/ of
# the v2 test job (tree, cargo-home, target) without changing any of it except adding target/release. All logs of THIS run go to
# $R/release-logs (never reused). Workspace release profile used UNCHANGED. Produces a live-run CANDIDATE only: not a test, no DB
# access; the A2 source pin BYTECODE_CHECKER_V2_SHA256 stays None (a separate reviewed source change).
set -uo pipefail
R=$(cd "$(dirname "$0")" && pwd)
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
. "$P/finality-stage/bytecode-v2-validation/jobs/env.sh"   # pinned v2 settings: S, B, CARGO_HOME/TARGET/TMPDIR, toolchain, -j1, offline
ip link set lo up 2>/dev/null || true
RL=$R/release-logs; T=$B/tree; M=$T/etc/tools/base-bytecode-check
die() { echo "## INVALID: $*"; echo "## release rc=1"; exit 1; }
sha() { sha256sum "$1" | cut -c1-64; }
# ---- pins: the exact tested v2 source and graph ----
STAGE_SUMS_SHA=051e8fccdb89cc589b94754143e0dab4bbbc569c1a670d8c4f76a94a167caa44     # bytecode-v2-validation/inputs/STAGE-SHA256SUMS
LIB_SHA=ed9870e7c89b5b8f8ecc9d38ddbc36614dfdcde6fb13e91f1150612feb5312df
MAIN_SHA=05dd717eb6da60ce38c9f852fe7656bb202f5ab985514001e72023eb192de25c
LOCK_SHA=91a9e7626b5f361faed8f5226268ffae177970575e8ecd243d09cb077bd23bab          # base lock + the one inserted entry (as v1)
CLOSURE_SHA=e901720ad6902c7ee60a4f6830b0052b638b707a9d2fef06d644a053c76e5aac
TEST_RUN=$P/logs/root-bytecode-v2-native-2249                                      # .out .rc .guard of root's v2 test job
RUSTC_V='rustc 1.96.0 (ac68faa20 2026-05-25)'; CARGO_V='cargo 1.96.0 (30a34c682 2026-05-25)'
[ "$S" = "$P/finality-stage/bytecode-v2-validation" ] || die "env.sh S is not the v2 stage"
[ ! -e "$RL" ] || die "$RL exists: a release run already happened (move it aside; never reused)"
mkdir -p "$RL" || die mkdir
exec > >(tee "$RL/release.log") 2>&1
echo "## [0] pins"
(cd "$R" && sha256sum -c --quiet inputs/RELEASE-STAGE-SHA256SUMS) || die "release stage files changed (inputs/RELEASE-STAGE-SHA256SUMS)"
[ "$(rustc --version)" = "$RUSTC_V" ] && [ "$(cargo --version)" = "$CARGO_V" ] || die "toolchain differs: $(rustc --version) | $(cargo --version)"
env | grep -q '^CARGO_PROFILE_RELEASE' && die "a CARGO_PROFILE_RELEASE_* override is set: the workspace profile must be used unchanged"
[ -z "${RUSTFLAGS:-}${CARGO_ENCODED_RUSTFLAGS:-}" ] || die "RUSTFLAGS already set"
# 0a. the full v2 test job PASSED (23/23 by name + 17 exact controls), and its receipt files are the root-pinned ones
[ -s "$R/inputs/PASSED-TEST-RECEIPTS.sha256" ] || die "inputs/PASSED-TEST-RECEIPTS.sha256 missing: pin root's passed test receipts first (README)"
(cd "$P" && sha256sum -c --quiet "$R/inputs/PASSED-TEST-RECEIPTS.sha256") || die "the pinned test receipts changed"
for x in out rc guard; do grep -q " logs/root-bytecode-v2-native-2249\.$x\$" "$R/inputs/PASSED-TEST-RECEIPTS.sha256" || die "receipt pin lacks .$x"; done
python3 -I -B "$R/check_test_receipt.py" "$TEST_RUN.out" "$TEST_RUN.rc" "$TEST_RUN.guard" "$S" > "$RL/test-receipt.json" \
  || die "the v2 test job is not a complete pass: $(cat "$RL/test-receipt.json")"
grep -q '^test result: ok\. 23 passed; 0 failed' "$S/logs/patched.test.out" || die "stage patched.test.out is not 23/23"
# 0b. the tested source, restored after every control, and the tested lock/closure/tree
[ "$(sha "$S/inputs/STAGE-SHA256SUMS")" = "$STAGE_SUMS_SHA" ] && (cd "$S" && sha256sum -c --quiet inputs/STAGE-SHA256SUMS) || die "v2 stage inputs changed"
[ "$(git -C "$BASE_REPO" rev-parse HEAD)" = "$BASE_REV" ] || die "base repo not at $BASE_REV"
[ "$(sha "$M/src/lib.rs")" = "$LIB_SHA" ] && [ "$(sha "$B/lib.rs.orig")" = "$LIB_SHA" ] && [ "$(sha "$M/src/main.rs")" = "$MAIN_SHA" ] \
  || die "member source is not the tested original (controls not restored?)"
diff -r "$S/crate" "$M" > /dev/null || die "member in build/tree differs from the v2 crate/"
[ "$(sha "$T/Cargo.lock")" = "$LOCK_SHA" ] || die "Cargo.lock differs from the tested one"
git -C "$BASE_REPO" archive "$BASE_REV" | tar -d -C "$T" > "$RL/tree-compare.txt" 2>&1
grep -vE '^Cargo.lock: |: (Uid|Gid) differs$' "$RL/tree-compare.txt" | grep -q . && die "build/tree differs from git archive $BASE_REV beyond Cargo.lock: $(head -3 "$RL/tree-compare.txt")"
python3 -I -B - "$T/Cargo.toml" <<'PY' || die "workspace [profile.release] differs from the pinned one"
import sys, tomllib
p = tomllib.load(open(sys.argv[1], 'rb'))['profile']['release']
sys.exit(0 if p == {'opt-level': 3, 'lto': 'thin', 'debug': 'none', 'strip': 'symbols', 'panic': 'unwind', 'codegen-units': 16} else 1)
PY
[ ! -e "$CARGO_TARGET_DIR/release" ] || die "pre-existing $CARGO_TARGET_DIR/release: refusing (a fresh, non-reused artifact is required)"
[ "$(sha "$S/inputs/closure-manifest.json")" = "$CLOSURE_SHA" ] || die "prepared closure manifest changed"
python3 -I -B "$S/jobs/verify_inputs.py" "$T/Cargo.lock" "$CARGO_HOME" "$RL/closure-manifest.json" > "$RL/verify_inputs.out" && cmp -s "$RL/closure-manifest.json" "$S/inputs/closure-manifest.json" \
  || die "closure inputs changed (private cargo home no longer matches the verified closure)"
echo "## pins ok: stage $STAGE_SUMS_SHA lib $LIB_SHA lock $LOCK_SHA closure $CLOSURE_SHA tree==archive(+lock) test receipt $(cat "$RL/test-receipt.json")"
export RUSTFLAGS='-C link-arg=-Wl,--threads=1'      # as root's v1 release: lld single-threaded
cd "$T" || die "no tree"
echo "## [1] release graph inside the verified closure (resolution only)"
cargo tree --offline --locked -p base-bytecode-check -e normal,build --prefix none --format '{p}' > "$RL/cargo-tree.release.txt" 2> "$RL/cargo-tree.release.err" \
  || die "--locked resolution failed: $(tail -3 "$RL/cargo-tree.release.err")"
echo "## [2] cargo build --release (jobs=$CARGO_BUILD_JOBS, RUSTFLAGS=$RUSTFLAGS)"
cargo build --offline --locked --release -p base-bytecode-check --bin base-bytecode-check --message-format=json > "$RL/release.build.json" 2> "$RL/release.build.err" \
  || die "release build FAILED: $(grep -m5 -E '^error' "$RL/release.build.err")"
python3 -I -B - "$RL/release.build.json" "$RL/closure-manifest.json" "$CARGO_TARGET_DIR" > "$RL/artifact.json" <<'PY' || die "release artifact checks failed: $(cat "$RL/artifact.json")"
import json, re, sys
msgs = [json.loads(l) for l in open(sys.argv[1]) if l.startswith('{')]
closure = {(p['name'], p['version']) for p in json.load(open(sys.argv[2]))['packages']}
arts = [m for m in msgs if m.get('reason') == 'compiler-artifact']
out = {'fail': []}
def pkg(m):                                     # cargo 1.96 package_id: "registry+...#name@ver" / "path+file:///...#ver" / "git+...#name@ver"
    pid = m['package_id']; frag = pid.rsplit('#', 1)[-1]
    return (frag.split('@')[0], frag.split('@')[1]) if '@' in frag else (m['target']['name'].replace('_', '-'), frag)
outside = sorted({pkg(m) for m in arts if not m['package_id'].startswith('path+')} - closure)
if outside: out['fail'].append(f'compiled packages outside the verified closure: {outside[:5]}')
if any(m['fresh'] for m in arts): out['fail'].append(f'{sum(m["fresh"] for m in arts)} artifacts reported FRESH: everything must be built by this run')
b = [m for m in arts if m['target']['name'] == 'base-bytecode-check' and 'bin' in m['target']['kind'] and m.get('executable')]
if len(b) != 1: out['fail'].append(f'expected exactly one release bin artifact, got {len(b)}')
else:
    b = b[0]; pr = b['profile']
    if not b['executable'].startswith(sys.argv[3] + '/release/'): out['fail'].append('artifact outside target/release')
    if (str(pr['opt_level']), pr['debug_assertions'], pr['overflow_checks'], pr['test']) != ('3', False, False, False):
        out['fail'].append(f'release profile fields differ: {pr}')
    out.update(executable=b['executable'], profile=pr, compiled=len(arts))
if not [m for m in msgs if m.get('reason') == 'build-finished' and m.get('success') is True]: out['fail'].append('no successful build-finished message')
print(json.dumps(out)); sys.exit(1 if out['fail'] else 0)
PY
BIN=$(python3 -I -B -c 'import json,sys; print(json.load(open(sys.argv[1]))["executable"])' "$RL/artifact.json")
BSHA=$(sha "$BIN"); BSIZE=$(stat -c %s "$BIN")
readelf -p .comment "$BIN" > "$RL/release.comment.txt" 2>&1 || true
[ "$(sha "$T/Cargo.lock")" = "$LOCK_SHA" ] && [ "$(sha "$M/src/lib.rs")" = "$LIB_SHA" ] || die "cargo changed the lock or the source"
(cd "$S" && sha256sum -c --quiet inputs/STAGE-SHA256SUMS) || die "v2 stage inputs changed during the build"
echo "## [3] usage smoke (no datadir access): no argument must be refused"
"$BIN" > "$RL/usage.out" 2>&1; U=$?; [ $U != 0 ] && grep -q 'usage: base-bytecode-check <datadir>' "$RL/usage.out" || die "usage smoke: rc=$U"
[ "$(sha "$BIN")" = "$BSHA" ] && [ "$(stat -c %s "$BIN")" = "$BSIZE" ] || die "the artifact changed after the build"
python3 -I -B - "$RL/release-manifest.json" "$RL/artifact.json" "$RL/test-receipt.json" <<PY || die "manifest"
import json, sys
a, t = json.load(open(sys.argv[2])), json.load(open(sys.argv[3]))
json.dump({'format': 'base-bytecode-check-release/v2', 'receiptFormat': 'base-bytecode-check/v2', 'artifact': '$BIN', 'sha256': '$BSHA', 'size': $BSIZE,
  'fresh': False, 'cargoProfileFields': a['profile'],
  'profile': 'release (workspace 5476069f: opt-level 3, lto thin, debug none, strip symbols, panic unwind, codegen-units 16; unchanged)',
  'rustflags': '$RUSTFLAGS', 'jobs': '$CARGO_BUILD_JOBS', 'rustc': '$RUSTC_V', 'cargo': '$CARGO_V', 'baseRev': '$BASE_REV',
  'cargoLockSha256': '$LOCK_SHA', 'closureManifestSha256': '$CLOSURE_SHA', 'libRsSha256': '$LIB_SHA', 'mainRsSha256': '$MAIN_SHA',
  'stageSumsSha256': '$STAGE_SUMS_SHA', 'testedBy': 'logs/root-bytecode-v2-native-2249 (23/23 + 17 exact controls; debug test profile, NOT this binary)',
  'patchedTestBinarySha256': t['patchedTestBinarySha256'],
  'notTested': 'this release binary on any datadir; live run under root review still required; A2 BYTECODE_CHECKER_V2_SHA256 stays None'}, open(sys.argv[1], 'w'), indent=1)
PY
echo "## release binary $BIN sha256 $BSHA size $BSIZE fresh=false opt=3"; sed -n 's/^ *\[ *[0-9a-f]*\] */## comment: /p' "$RL/release.comment.txt"
echo "## release rc=0"
