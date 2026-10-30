#!/usr/bin/env bash
# Corrected native Helios CLI for the attested/host verifier packages: committed eeffcc9 + canonical-block.patch 41667ec9
# (the TESTED candidate: 35 named + 91 core tests, 12/12 required controls, EVM 9 + 100 core + 5 EVM controls).
# ROOT-LAUNCHED, FOREGROUND, OFFLINE, ONE compiler job, from work/rpc-production-final-20261025:
#   ./jobs/q-exit-status.sh canonical-helios-build-N 2560 unshare -rn bash canonical-verifier-binary-stage/jobs/build-helios.sh
# Optional (speed only): CANONICAL_CACHE_FROM=<ended run under verifier-canonical-stage/run> reuses that run's cargo-home + target
# in place (the ORIGINAL common.sh reuse_cache: ended, unused, lock, caches == CH0); the CLI package is then cleaned so the
# helios binary is REBUILT. Not an independent reproduction either way.
# Recipe = the recorded cc962e2b recipe (R3x reproduced it from committed eeffcc9): dev profile with debuginfo off
# (CARGO_PROFILE_DEV_DEBUG=0), -p helios-cli --bin helios, CARGO_BUILD_JOBS=1, CARGO_INCREMENTAL=0, RUSTFLAGS -Wl,--threads=1,
# Rust 1.96.0, offline --locked; SOURCE_DATE_EPOCH = eeffcc9's commit time (OpenSSL build stamp). Same profile/flags as the
# tested build (debug assertions ON, as tested). The binary is NOT a pass by itself: its hash binds only to the inputs below.
set -uo pipefail
. /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/verifier-canonical-stage/jobs/common.sh   # ORIGINAL, read-only
BS=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/canonical-verifier-binary-stage
W=${BS%/canonical-verifier-binary-stage}; SDE=1792720709
V=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-rpc-runtime-launch/chain-verifier-inputs
h() { sha256sum < "$1" | cut -c1-64; }
echo "== frozen inputs and tested evidence"
need "common.sh 2c751494" [ "$(h $S/jobs/common.sh)" = 2c7514948752c436376dac7c34cbad2dbde971f61b0343f26e1997c7eebdba14 ]
need "canonical-block.patch 41667ec9" [ "$(h $S/canonical-block.patch)" = 41667ec946d2f591498e4ab9d791914a6d5c886221996c5f0c920a0be39dcc31 ]
need "PATCHED.sha256 7e87fad8" [ "$(h $S/PATCHED.sha256)" = 7e87fad838fcccdf801fa3ee732ca878b56799f44b4d64973a2265853769b0f3 ]
need "INPUT-MANIFEST.base-eeffcc9 pinned" [ "$(h $S/INPUT-MANIFEST.base-eeffcc9.sha256)" = "$(sed -n 's/^INPUT-MANIFEST //p' $BS/jobs/PINS.txt)" ]
need "tested-evidence receipts unchanged (TESTED-EVIDENCE.sha256)" bash -c "cd $W && sha256sum -c --quiet $BS/jobs/TESTED-EVIDENCE.sha256"
need "runtime pin set equals the reviewed original" cmp "$V/PINS.sha256" "$BS/integration/OLD-PINS.sha256"
need "glibcRuntime/natives dir PINS.sha256 (for the runtime smoke)" bash -c "cd $V && sha256sum -c --quiet PINS.sha256"
X=$BS/run/build-$(date -u +%Y%m%dT%H%M%SZ); prepare $X 1; cd $X/helios; closure_check $X
need "eeffcc9 commit time == SOURCE_DATE_EPOCH $SDE" [ "$(git -C $X/helios log -1 --format=%ct $BASE)" = $SDE ]
export SOURCE_DATE_EPOCH=$SDE
need "toolchain is 1.96.0" bash -c 'rustc -V | grep -q "^rustc 1.96.0 " && cargo -V | grep -q "^cargo 1.96.0 "'
if [ -s $X/CACHE-REUSED-FROM ]; then echo "== reuse: clean ONLY the CLI package so the binary is rebuilt"; cargo clean --offline -p helios-cli || { echo "RESULT: CLEAN-FAILED"; exit 24; }; fi
echo "== build helios-cli ($(date -u +%FT%TZ)) SOURCE_DATE_EPOCH=$SDE RUSTFLAGS='$RUSTFLAGS' CARGO_PROFILE_DEV_DEBUG=$CARGO_PROFILE_DEV_DEBUG jobs=$CARGO_BUILD_JOBS"
timeout -k 10 5400 cargo build --offline --locked -p helios-cli --bin helios --message-format=json-render-diagnostics > $X/build.json 2> $X/build.err; br=$?
echo "## cargo build rc=$br ($(date -u +%FT%TZ))"; tail -3 $X/build.err
[ $br = 0 ] || { echo "RESULT: BUILD-FAILED (rc $br; never an artifact)"; exit 20; }
lock_unchanged $X
EXE=$(python3 -I - $X/build.json <<'PY'
import json, sys
arts = [json.loads(l) for l in open(sys.argv[1]) if l.startswith('{"reason":"compiler-artifact"')]
h = [a for a in arts if a["target"]["name"] == "helios" and a["target"]["kind"] == ["bin"] and a.get("executable")]
fresh = [a["package_id"] for a in arts if a["fresh"]]
print(f"[artifacts] {len(arts)} units, {len(fresh)} fresh (reused from the cache)", file=sys.stderr)
if len(h) != 1 or h[0]["fresh"] or h[0]["profile"]["opt_level"] != "0" or h[0]["profile"]["debug_assertions"] is not True:
    print(f"helios bin artifact: {[(a['fresh'], a['profile']) for a in h]}", file=sys.stderr); sys.exit(1)
print(h[0]["executable"])
PY
) || { echo "RESULT: ARTIFACT-REFUSED (missing, FRESH or not the dev profile)"; exit 25; }
O=$X/out; mkdir -p $O; cp -p "$EXE" $O/helios; A=$(h $O/helios)
echo "== artifact"; echo "[artifact] $A  helios  ($(stat -c %s $O/helios) bytes)"
readelf -n $O/helios | grep -i "build id" | sed 's/^ */[artifact] /'; readelf -p .comment $O/helios | grep -v '^$\|String dump' | sed 's/^ */[artifact] comment /'
echo "[artifact] interpreter: $(readelf -l $O/helios | sed -n 's/.*interpreter: \(.*\)\]/\1/p'); NEEDED: $(readelf -d $O/helios | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | tr '\n' ' '); RPATH/RUNPATH: $(readelf -d $O/helios | grep -c 'R.*PATH')"
echo "[artifact] highest GLIBC: $(readelf -V -W $O/helios | grep -oE 'GLIBC_[0-9.]+' | sort -t. -k2 -n -u | tail -1)"
need "NEEDED subset of the pinned glibcRuntime (libc, libm, libgcc_s, ld-linux)" bash -c "[ -z \"\$(readelf -d $O/helios | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | grep -vxE 'libc.so.6|libm.so.6|libgcc_s.so.1|ld-linux-x86-64.so.2')\" ]"
echo "[artifact] absolute build-path strings (debug build, informational): $(LC_ALL=C grep -aFc "$X" $O/helios)"
echo "== smoke (offline, HOME=$O/home, 30 s each): host runtime AND the image's pinned glibcRuntime loader"
mkdir -p $O/home $O/rt; cp -p $V/ld-linux-x86-64.so.2 $V/libc.so.6 $V/libm.so.6 $V/libgcc_s.so.1 $O/rt/   # = the image glibcRuntime dir (4 files)
for mode in host pinned-runtime; do
  if [ $mode = host ]; then run=( $O/helios ); else run=( $O/rt/ld-linux-x86-64.so.2 --library-path $O/rt $O/helios ); fi
  HOME=$O/home timeout 30 "${run[@]}" --version > $O/smoke-$mode-version.txt 2>&1; need "$mode: helios --version rc 0 ($(head -1 $O/smoke-$mode-version.txt))" [ $? = 0 ]
  HOME=$O/home timeout 30 "${run[@]}" --help > $O/smoke-$mode-help.txt 2>&1; need "$mode: helios --help rc 0" [ $? = 0 ]
done
for sub in $(sed -n '/^Commands:/,/^$/p' $O/smoke-host-help.txt | awk 'NR>1 && $1!="help" {print $1}'); do HOME=$O/home timeout 30 $O/helios $sub --help > $O/smoke-host-help-$sub.txt 2>&1; subrc=$?; echo "[smoke] $sub --help rc $subrc"; need "$sub --help rc 0" [ "$subrc" = 0 ]; done
rm -rf $O/rt $O/home
python3 -I - $O $A $X $BS <<PY > $O/provenance.json || { echo "RESULT: PROVENANCE-FAILED"; exit 26; }
import hashlib, json, pathlib, sys
o, a, x, bs = sys.argv[1:]; sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
print(json.dumps({"format": "canonical-helios-artifact/v1", "artifact": {"file": "helios", "sha256": a, "bytes": pathlib.Path(o, "helios").stat().st_size},
 "source": {"repo": "$SRC", "baseCommit": "$BASE", "baseTree": "$TREE", "cargoLockSha256Prefix": "$LOCK", "patch": {"file": "$S/canonical-block.patch", "sha256": sha("$S/canonical-block.patch")},
            "patchedFiles": {l.split()[1]: l.split()[0] for l in open("$S/PATCHED.sha256")}, "inputManifest": sha("$S/INPUT-MANIFEST.base-eeffcc9.sha256"),
            "vendor": {"tar": "$VTAR", "sha256": "$VTARSHA", "extractionTreehash": "$VBASE"}},
 "dependencies": {"cargoHome": open(x + "/CACHE-REUSED-FROM").read().strip() if pathlib.Path(x, "CACHE-REUSED-FROM").exists() else "fresh copy of $CH0 (treehash verified)",
                  "closure": "cargo metadata/fetch --offline --locked inside the work dir (26 path packages)", "lockUnchanged": True},
 "build": {"command": "cargo build --offline --locked -p helios-cli --bin helios", "profile": "dev, CARGO_PROFILE_DEV_DEBUG=0 (opt 0, debug assertions on)", "jobs": 1, "incremental": 0,
           "rustflags": "$RUSTFLAGS", "sourceDateEpoch": $SDE, "toolchain": "$(rustc -vV | tr '\n' ' ')/ $(cargo -V)", "cc": "$(cc --version | head -1)"},
 "testedBy": {l.split()[1]: l.split()[0] for l in open(bs + "/jobs/TESTED-EVIDENCE.sha256")},
 "smoke": {p.name: sha(p) for p in sorted(pathlib.Path(o).glob("smoke-*.txt"))},
 "claims": "ONE build of the tested candidate source; hash binds to these inputs only; NOT an independent reproduction; not deployed; not SNP-qualified"}, indent=1))
PY
(cd $O && sha256sum helios smoke-*.txt provenance.json > SHA256SUMS)
echo "## rc=0 (canonical Helios artifact $A built; NOT a pass, NOT a reproduction, NOT deployed)"
