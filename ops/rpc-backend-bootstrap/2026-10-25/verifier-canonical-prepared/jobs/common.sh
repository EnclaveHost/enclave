# Shared, read-only setup for the canonical-block jobs (verifier-canonical-stage). Sourced; never edits the originals.
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/verifier-canonical-stage
. /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/native-provenance-audit-stage/reproduce/jobs/inputs.sh   # need, treehash, offline, toolchain
SRC=$B/rpc-priority/helios-patched; CH0=$B/rpc-priority/cargo-home
BASE=eeffcc980a4a9aa092e23e07b1077c1f3fdfc95e; TREE=2171ad2bfd3c97f2e0e029e866b1a8535cbbd187; LOCK=28f4400cef93f04c28c2   # Cargo.lock sha256 prefix (R3x)
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
  CHH=$(treehash $CH0); cp -a $CH0 $X/cargo-home; need "cargo-home copy == original" [ "$(treehash $X/cargo-home)" = "$CHH" ]
  export RUSTUP_TOOLCHAIN=1.96.0 RUSTUP_AUTO_INSTALL=0 CARGO_HOME=$X/cargo-home CARGO_TARGET_DIR=$X/target CARGO_BUILD_JOBS=1 \
         CARGO_NET_OFFLINE=true CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 RUSTFLAGS="-C link-arg=-Wl,--threads=1"
  rustc --version; cargo --version
}
TESTS="--test block_cache_exact_hash --test canonical_block_gate --test node_canonical_methods --test rpc_exact_hash_postcondition --test ancestor_block_hash"
lock_unchanged() { git -C $1/helios diff --quiet Cargo.lock && echo "[ok] Cargo.lock unchanged" || { echo "[FAIL] Cargo.lock CHANGED"; exit 4; }; }
