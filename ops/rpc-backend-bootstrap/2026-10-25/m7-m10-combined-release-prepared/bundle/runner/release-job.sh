#!/bin/bash
# COMBINED M7+M10 Base release build on the private RPC guest (launched ONLY by run-release.sh as m10build; offline; ONE compiler
# job). Recipe = the reviewed host M7 production build.sh (2ee8b8de) with guest paths and the combined source: git archive
# 5476069f + M7 e9dfb8c6 + FIXED M10 d97c31b5; profile = release with lto=false; SOURCE_DATE_EPOCH; Rust and C path remaps.
# The release tree must equal the tree run 2 TESTED (cryptographic binding; no test is recompiled here). Every compiled unit
# must be built in this run (fresh=false) into a NEW target. ONE build: not an independent reproduction.
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/guest-env-release.sh"
die() { echo "## INVALID/FAILED: $*"; echo "## rc=1"; exit 1; }
need() { local w=$1; shift; "$@" && echo "[ok] $w" || die "$w"; }
sha() { sha256sum < "$1" | cut -c1-64; }
manifest() { (cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) | sha256sum | cut -c1-64; }
echo "== toolchain and pins"
need "rustc 1.96.0 from the staged toolchain" bash -c "[ \"\$(rustc --version)\" = 'rustc 1.96.0 (ac68faa20 2026-05-25)' ] && [ \"\$(command -v rustc)\" = '$TC/bin/rustc' ]"
need "cargo 1.96.0 from the staged toolchain" bash -c "[ \"\$(cargo --version)\" = 'cargo 1.96.0 (30a34c682 2026-05-25)' ] && [ \"\$(command -v cargo)\" = '$TC/bin/cargo' ]"
need "base tar a92160eb" [ "$(sha $OLD/src/base-$BASE_REV.tar)" = $BASE_TAR_SHA ]
need "M7 patch e9dfb8c6" [ "$(sha $M/inputs/base-l1-verify.patch)" = $M7_PATCH_SHA ]
need "fixed M10 patch d97c31b5" [ "$(sha $M/inputs/m10-bootstrap-anchor.patch)" = $M10_FIXED_SHA ]
need "release dirs are new" bash -c "[ ! -e '$REL/build' ] && [ ! -e '$OUT' ]"
mkdir -p "$S" "$OUT/home" "$L" || die mkdir
echo "== combined source (tar + M7 + fixed M10)"
tar -x -C "$S" -f "$OLD/src/base-$BASE_REV.tar" || die "tar -x"
(cd "$S" && git apply --check "$M/inputs/base-l1-verify.patch" && git apply "$M/inputs/base-l1-verify.patch" && git apply --check "$M/inputs/m10-bootstrap-anchor.patch" && git apply "$M/inputs/m10-bootstrap-anchor.patch") || die "patches do not apply"
SRCM=$(manifest "$S"); echo "[pin] release source manifest $SRCM ($(cd "$S" && find . -type f | wc -l) files)"
need "source manifest == 58c572cb (expected combined tree)" [ "$SRCM" = $SRC_MANIFEST ]
need "release tree == the tree run 2 TESTED ($RUN2/build/tree)" [ "$(manifest "$RUN2/build/tree")" = "$SRCM" ]
need "Cargo.lock f122da76" [ "$(sha "$S/Cargo.lock")" = $LOCK_SHA ]
need "M7 gate: CLI default l1 trust-rpc = false" grep -q '^const DEFAULT_L1_TRUST_RPC: bool = false;$' "$S/crates/consensus/cli/src/l1.rs"
need "M7 gate: provider == validated 201d9b8c" [ "$(sha "$S/crates/consensus/providers/src/chain_provider.rs")" = 201d9b8c16b080a4f7111ca29ec5ece8f02a2b9be807bb06e24e7eb1248bb3b2 ]
need "M10 gate: --bootstrap.anchor declared exactly twice (rpc-embedded + standalone consensus args; none in sequencer args)" [ "$(grep -c 'long = "bootstrap.anchor"' "$S/crates/consensus/cli/src/node.rs")" = 2 ]
echo "== reused cargo home (ENDED run 1): offline dependency verification"
python3 -I "$M/runner/verify-deps.py" "$S/Cargo.lock" "$CARGO_HOME" > "$L/verify-deps.json" || die "offline dependency verification failed"
echo "[ok] $(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["registryPackages"],"registry +",d["gitPackages"],"git, fsck",all(d["fsckFullStrict"].values()))' "$L/verify-deps.json")"
echo "[cache] CARGO_HOME files before: $(find "$CARGO_HOME" -type f | wc -l); disk free $(df --output=avail -m "$REL" | tail -1 | tr -d ' ') MiB"
echo "== build ($(date -u +%FT%TZ))"
export SOURCE_DATE_EPOCH=$EPOCH
export RUSTFLAGS="-C link-arg=-Wl,--threads=1 --remap-path-prefix=$S=/build/base --remap-path-prefix=$CARGO_HOME=/cargo --remap-path-prefix=$TGT=/target"
export CFLAGS="-ffile-prefix-map=$S=/build/base -ffile-prefix-map=$CARGO_HOME=/cargo -ffile-prefix-map=$TGT=/target"
export CXXFLAGS="$CFLAGS"
echo "[env] CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS SOURCE_DATE_EPOCH=$EPOCH PROFILE=$PROFILE RUSTFLAGS='$RUSTFLAGS' CFLAGS='$CFLAGS'"
cd "$S" || die "no tree"
timeout -k 30 21600 cargo build --locked --offline -p base --bin base --message-format=json \
  --config "profile.$PROFILE.inherits=\"release\"" --config "profile.$PROFILE.lto=false" --profile $PROFILE > "$L/release.build.json" 2> "$L/release.build.err"; r=$?
echo "## cargo build rc=$r ($(date -u +%FT%TZ))"; [ $r = 0 ] || die "cargo build failed (rc $r): $(grep -m5 -E '^error' "$L/release.build.err")"
need "Cargo.lock unchanged" [ "$(sha "$S/Cargo.lock")" = $LOCK_SHA ]
B=$(python3 -I - "$L/release.build.json" <<'PY'
import json, sys
arts = [json.loads(l) for l in open(sys.argv[1]) if l.startswith('{"reason":"compiler-artifact"')]
fresh = sorted({a["package_id"] for a in arts if a["fresh"]})
bins = [a["executable"] for a in arts if a["target"]["name"] == "base" and "bin" in a["target"]["kind"] and a.get("executable")]
print(f"[artifacts] {len(arts)} compiler artifacts, {len(fresh)} fresh", file=sys.stderr)
if fresh or len(bins) != 1 or not arts: print(f"fresh={fresh[:5]} bins={bins}", file=sys.stderr); sys.exit(1)
print(bins[0])
PY
) || die "a unit was FRESH (not built in this run) or the base binary artifact is missing"
echo "[ok] every compiled unit was built in this run (fresh=false); binary $B"
cp -p "$B" "$OUT/base" || die "copy"
echo "== artifact"; A=$(sha "$OUT/base"); echo "[artifact] $A  base  ($(stat -c %s "$OUT/base") bytes)"
readelf -n "$OUT/base" | grep -i "build id" | sed 's/^ */[artifact] /'; readelf -p .comment "$OUT/base" 2>/dev/null | grep -v '^$\|String dump' | sort -u | sed 's/^ */[artifact] comment /'
echo "[artifact] NEEDED: $(readelf -d "$OUT/base" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | tr '\n' ' ')"
echo "[artifact] highest required: $(readelf -V -W "$OUT/base" | grep -oE 'Name: (GLIBC|GLIBCXX|CXXABI|OPENSSL|GCC)_[0-9.]+' | sed 's/Name: //' | sort -t_ -k1,1 -k2,2V | awk -F_ '{m[$1]=$0} END {for (k in m) printf "%s ", m[k]}')"
echo "[artifact] build-path strings (should be 0): $(LC_ALL=C grep -aFc -e "$S" -e "$CARGO_HOME" -e "$TGT" "$OUT/base")"
echo "== smoke (bounded, no network, no data dir, HOME=$OUT/home)"
cd "$OUT"; export HOME=$OUT/home
timeout 30 ./base --version > smoke-version.txt 2>&1; v=$?; cat smoke-version.txt; need "base --version rc 0" [ $v = 0 ]
timeout 30 ./base --help > smoke-help.txt 2>&1; need "base --help rc 0" [ $? = 0 ]
for sub in rpc follow sequencer; do timeout 30 ./base $sub --help > "smoke-help-$sub.txt" 2>&1; need "base $sub --help rc 0" [ $? = 0 ]; done
for sub in rpc follow sequencer; do need "M7 flag (env BASE_NODE_L1_TRUST_RPC) in $sub" grep -q 'BASE_NODE_L1_TRUST_RPC' "smoke-help-$sub.txt"; done
need "M10 flag --bootstrap.anchor in rpc" grep -q -- '--bootstrap.anchor <NUMBER:HASH>' smoke-help-rpc.txt
need "M10 flag absent from sequencer" bash -c "! grep -q -- '--bootstrap.anchor' smoke-help-sequencer.txt"
need "M10 flag has no env binding in rpc help" bash -c "! grep -A4 -- '--bootstrap.anchor <NUMBER:HASH>' smoke-help-rpc.txt | grep -q '\[env:'"
echo "[info] --bootstrap.anchor in follow help: $(grep -c -- '--bootstrap.anchor' smoke-help-follow.txt)"
python3 -I - "$OUT" "$A" "$SRCM" <<PY > provenance.json || die "provenance"
import hashlib, json, sys, pathlib
o, a, s = sys.argv[1:]
print(json.dumps({"artifact": {"file": "base", "sha256": a}, "source": {"baseRev": "$BASE_REV", "baseTar": "$BASE_TAR_SHA", "m7Patch": "$M7_PATCH_SHA", "m10FixedPatch": "$M10_FIXED_SHA", "manifest": s, "cargoLock": "$LOCK_SHA"},
 "testedBy": {"run2Tree": "$RUN2/build/tree", "run2TreeManifest": s, "run2OriginalReceiptPass": False, "compoundGate": json.load(open("$REL/compound-gate.json"))},
 "build": {"toolchain": "rustc 1.96.0 ac68faa20 / cargo 30a34c682 (staged official dist)", "profile": "$PROFILE (release, lto=false)", "jobs": 1, "sourceDateEpoch": $EPOCH,
           "rustflags": "-C link-arg=-Wl,--threads=1 + remaps", "host": "private RPC guest (Ubuntu 24.04), uid m10build", "cargoHome": "reused from ENDED run 1 (verified offline; sources only)", "target": "NEW, every unit fresh=false"},
 "smoke": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(pathlib.Path(o).glob("smoke-*.txt"))},
 "claims": "ONE build of the combined M7+M10 source; NOT an independent reproduction; not deployed"}, indent=1))
PY
sha256sum base smoke-*.txt provenance.json > SHA256SUMS
echo "[cache] CARGO_HOME files after: $(find "$CARGO_HOME" -type f | wc -l); release dir $(du -sm "$REL" | cut -f1) MiB; disk free $(df --output=avail -m "$REL" | tail -1 | tr -d ' ') MiB"
echo "## rc=0 (ONE combined M7+M10 release build; tree == run-2 tested tree; NOT an independent reproduction)"
