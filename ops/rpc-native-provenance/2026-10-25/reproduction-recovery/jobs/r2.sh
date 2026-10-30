#!/usr/bin/env bash
# R2: witness-check (debug) at the COMMITTED ef320298, at the ORIGINAL absolute paths of the build that produced the pin 4fe0cd3b
# (witness-failover/jobs/helper-build-test-r5.sh: same env, flags and command). A private mount namespace places a FRESH clean clone
# over witness-failover/helios, a FRESH empty dir over witness-failover/target and a private COPY over witness-failover/cargo-home,
# and makes witness-failover/vendor-inspect read-only. The real tree, target and cache are never written (verified before/after).
set -uo pipefail
. "$(dirname "$0")/inputs.sh"
W=$B/witness-failover; X=$R/r2${VERIFY_ONLY:+-verify}; P=4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411
if [ "${1:-}" != inner ]; then
  offline; toolchain
  echo "== pre: originals"
  need "fresh $X" [ ! -e "$X" ]
  need "original helios repo tree eec339e1" [ "$(git -C $W/helios rev-parse HEAD^{tree})" = eec339e18296d850a514f72de2efdd8729302efd ]
  need "original helios repo clean" [ -z "$(git -C $W/helios status --porcelain --untracked-files=all)" ]
  need "original target binary == pin" [ "$(sha256sum < $W/target/debug/witness-check | cut -c1-64)" = $P ]
  CH0=$(treehash $W/cargo-home); VI0=$(treehash $W/vendor-inspect); echo "[pre] cargo-home manifest $CH0; vendor-inspect manifest $VI0"
  mkdir -p $X
  git clone -q --no-local --no-hardlinks --no-checkout $W/helios $X/helios && git -C $X/helios -c advice.detachedHead=false checkout -q --detach ef3202982b475212d9bb6adfdc3eed4ebb0b83c5
  need "clone: ef320298 tree eec339e1" [ "$(git -C $X/helios rev-parse HEAD^{tree})" = eec339e18296d850a514f72de2efdd8729302efd ]
  need "clone: clean" [ -z "$(git -C $X/helios status --porcelain --untracked-files=all)" ]
  need "clone: Cargo.lock 28f4400c (closure.json)" [ "$(sha256sum < $X/helios/Cargo.lock | cut -c1-8)" = 28f4400c ]
  cp -a $W/cargo-home $X/cargo-home; need "cargo-home copy == original" [ "$(treehash $X/cargo-home)" = "$CH0" ]
  mkdir -p $X/target
  unshare -m --propagation private bash "$0" inner; irc=$?
  echo "== post: originals unchanged"
  need "original helios repo HEAD unchanged" [ "$(git -C $W/helios rev-parse HEAD)" = ef3202982b475212d9bb6adfdc3eed4ebb0b83c5 ]
  need "original helios repo still clean" [ -z "$(git -C $W/helios status --porcelain --untracked-files=all)" ]
  need "original target binary still == pin" [ "$(sha256sum < $W/target/debug/witness-check | cut -c1-64)" = $P ]
  need "original cargo-home unchanged" [ "$(treehash $W/cargo-home)" = "$CH0" ]
  need "vendor-inspect unchanged" [ "$(treehash $W/vendor-inspect)" = "$VI0" ]
  need "clone still clean after build" [ -z "$(git -C $X/helios status --porcelain --untracked-files=all)" ]
  [ "${VERIFY_ONLY:-0}" = 1 ] && { echo "[verify] VERIFY_ONLY: namespace mounts and originals verified (inner rc=$irc); no compilation, no receipt"; exit $irc; }
  r=$(sha256sum < $X/target/debug/witness-check 2>/dev/null | cut -c1-64); echo "[result] rebuilt $r"; echo "[result] pin     $P"
  echo "$r  r2/witness-check" > $R/receipts/r2.sha256
  [ $irc -eq 0 ] || { echo "[r2] build rc=$irc"; exit 1; }
  [ "$r" = "$P" ] && { echo "[result] REPRODUCED the pin from committed ef320298"; exit 0; } || { echo "[result] NOT equal to the pin (does not by itself prove the source differed)"; exit 1; }
fi
# ---- inner: private mount namespace -------------------------------------------------------------------------------------------
set -e
mount --bind $X/helios $W/helios; mount --bind $X/target $W/target; mount --bind $X/cargo-home $W/cargo-home
mount --bind $W/vendor-inspect $W/vendor-inspect; mount -o remount,bind,ro $W/vendor-inspect
need "mounted: original path shows the clone (HEAD ef320298)" [ "$(git -C $W/helios rev-parse HEAD)" = ef3202982b475212d9bb6adfdc3eed4ebb0b83c5 ]
need "mounted: original target path is the empty fresh dir" [ -z "$(ls -A $W/target)" ]
need "mounted: cargo-home path is the copy" [ "$(stat -c %i $W/cargo-home)" = "$(stat -c %i $X/cargo-home)" ]
need "mounted: vendor-inspect read-only" bash -c "! touch $W/vendor-inspect/.w 2>/dev/null"
[ "${VERIFY_ONLY:-0}" = 1 ] && { echo "[inner] VERIFY_ONLY: mounts verified; stopping before compilation"; exit 0; }
export RUSTUP_TOOLCHAIN=1.96.0 RUSTUP_AUTO_INSTALL=0
export CARGO_HOME=$W/cargo-home CARGO_TARGET_DIR=$W/target CARGO_BUILD_JOBS=1 CARGO_NET_OFFLINE=true CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 RUSTFLAGS="-C link-arg=-Wl,--threads=1"
rustc --version; cd $W/helios; git log --oneline -1; git status --short
echo "== build witness-check $(date -u +%FT%TZ)"
timeout -k 10 5400 cargo build --offline -p helios-opstack --bin witness-check
date -u +%FT%TZ; sha256sum $CARGO_TARGET_DIR/debug/witness-check
git diff --quiet Cargo.lock && echo "Cargo.lock unchanged" || { echo "Cargo.lock CHANGED"; exit 4; }
