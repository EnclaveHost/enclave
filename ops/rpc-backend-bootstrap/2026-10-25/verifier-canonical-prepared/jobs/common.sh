# Shared, read-only setup for the canonical-block jobs (verifier-canonical-stage). Sourced; never edits the originals.
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/verifier-canonical-stage
. /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/native-provenance-audit-stage/reproduce/jobs/inputs.sh   # need, treehash, offline, toolchain
SRC=$B/rpc-priority/helios-patched; CH0=$B/rpc-priority/cargo-home
BASE=eeffcc980a4a9aa092e23e07b1077c1f3fdfc95e; TREE=2171ad2bfd3c97f2e0e029e866b1a8535cbbd187; LOCK=28f4400cef93f04c28c2   # Cargo.lock sha256 prefix (R3x)
# The helios workspace's out-of-tree path dependencies (opstack -> ../../vendor-inspect/base-v1.5.1/crates/common/{evm,chains},
# and their 10 base-* path crates) come from the PINNED base v1.5.1 archive, extracted exactly as the reviewed
# r1r.sh:28 / build-binaries.sh:39-40 do. (R3x used rpc-priority/vendor-inspect, a mutable shallow clone of the same commit
# 5476069f whose files are byte-identical to this extraction plus a .git; it is never linked or read here.)
VTAR=$TAR; VTARSHA=9784e20a3cfeac555d96e8d1f15526d5264f0e6d8885b951c6f1220355038012
VBASE=c93014900f2a2bec5b347f6dc8df31368d5f5911f2720274eceff424bbb282ab                     # treehash of the extracted base-v1.5.1
prepare() {   # $1 = fresh work dir; $2 = apply patch? (1|0)
  local X=$1
  ip link set lo up 2>/dev/null || true   # run under `unshare -rn`: loopback only (the regression binds 127.0.0.1)
  offline; toolchain
  need "fresh $X" [ ! -e "$X" ]
  need "source repo HEAD eeffcc9" [ "$(git -C $SRC rev-parse HEAD)" = $BASE ]
  need "source repo clean" [ -z "$(git -C $SRC status --porcelain --untracked-files=all)" ]
  mkdir -p $X
  git clone -q --no-local --no-hardlinks --no-checkout $SRC $X/helios && git -C $X/helios -c advice.detachedHead=false checkout -q --detach $BASE
  need "clone tree == R3x tree" [ "$(git -C $X/helios rev-parse HEAD^{tree})" = $TREE ]
  need "clone Cargo.lock == R3x" [ "$(sha256sum < $X/helios/Cargo.lock | cut -c1-20)" = $LOCK ]
  (cd $X/helios && sha256sum -c --quiet <(grep -v '^tree ' $S/INPUT-MANIFEST.base-eeffcc9.sha256)) && echo "[ok] base files == INPUT-MANIFEST" || { echo "[FAIL] base files differ"; exit 9; }
  if [ "$2" = 1 ]; then
    git -C $X/helios apply --check $S/canonical-block.patch && git -C $X/helios apply $S/canonical-block.patch || { echo "[FAIL] patch does not apply"; exit 9; }
    (cd $X/helios && sha256sum -c --quiet $S/PATCHED.sha256) && echo "[ok] patched files == PATCHED.sha256" || { echo "[FAIL] patched files differ"; exit 9; }
  fi
  need "base archive pin 9784e20a" [ "$(sha256sum < $VTAR | cut -c1-64)" = $VTARSHA ]
  mkdir -p $X/vendor-inspect/base-v1.5.1
  tar -xzf $VTAR -C $X/vendor-inspect/base-v1.5.1 --strip-components=1 "base-5476069f1eb74a56bccb56fdefd4b4bb0e3cda42/"
  need "vendor-inspect/base-v1.5.1 == pinned extraction c9301490" [ "$(treehash $X/vendor-inspect/base-v1.5.1)" = $VBASE ]
  need "vendor-inspect holds only base-v1.5.1" [ "$(ls -A $X/vendor-inspect)" = base-v1.5.1 ]
  chmod -R a-w $X/vendor-inspect                     # read-only, as R3x's ro mount (cleanup: chmod -R u+w first)
  CHH=$(treehash $CH0); cp -a $CH0 $X/cargo-home; need "cargo-home copy == original" [ "$(treehash $X/cargo-home)" = "$CHH" ]
  export RUSTUP_TOOLCHAIN=1.96.0 RUSTUP_AUTO_INSTALL=0 CARGO_HOME=$X/cargo-home CARGO_TARGET_DIR=$X/target CARGO_BUILD_JOBS=1 \
         CARGO_NET_OFFLINE=true CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 RUSTFLAGS="-C link-arg=-Wl,--threads=1"
  rustc --version; cargo --version
}
TESTS="--test block_cache_exact_hash --test canonical_block_gate --test node_canonical_methods --test rpc_exact_hash_postcondition --test ancestor_block_hash"
lock_unchanged() { git -C $1/helios diff --quiet Cargo.lock && echo "[ok] Cargo.lock unchanged" || { echo "[FAIL] Cargo.lock CHANGED"; exit 4; }; }

# BEFORE any build (cwd = $X/helios): the locked dependency closure must resolve offline entirely inside this work dir,
# and every crate the locked graph needs for this target must already be in the copied cache. Neither is a test verdict.
closure_check() {
  local X=$1
  echo "== A0: locked closure (cargo metadata --offline --locked)"
  timeout -k 10 600 cargo metadata --offline --locked --format-version 1 > $X/metadata.json 2> $X/metadata.err \
    || { cat $X/metadata.err; echo "RESULT: CLOSURE-FAILURE (the locked closure does not resolve offline; not a test verdict)"; exit 21; }
  python3 - "$X" $X/metadata.json <<'PYC' || { echo "RESULT: CLOSURE-FAILURE (a path package resolves outside the work dir)"; exit 21; }
import json, sys
x, m = sys.argv[1], json.load(open(sys.argv[2]))
paths = [p for p in m["packages"] if p.get("source") is None]
out = [p["name"] + " " + p["manifest_path"] for p in paths if not (p["manifest_path"].startswith(x + "/helios/") or p["manifest_path"].startswith(x + "/vendor-inspect/base-v1.5.1/"))]
print(f"[closure] {len(paths)} path packages; outside the work dir: {len(out)}"); [print("  ", o) for o in out]
sys.exit(1 if out or len(paths) != 26 else 0)
PYC
  echo "== A0: dependency cache (cargo fetch --offline --locked, this target)"
  timeout -k 10 1800 cargo fetch --offline --locked --target x86_64-unknown-linux-gnu > $X/fetch.out 2>&1 \
    || { tail -20 $X/fetch.out; echo "RESULT: DEV-CACHE-MISSING (explicit blocker: a locked crate is not in the reviewed cache; not a verdict)"; exit 22; }
  lock_unchanged $X
}
