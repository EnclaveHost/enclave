#!/usr/bin/env bash
# R3X (prepared, NOT launched): r3.sh with SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH_PIN for the OpenSSL build stamp only; tests the diagnosis that the
# eeffcc9 rebuild differs from cc962e2b only by that stamp. Run: C=eeffcc9 SOURCE_DATE_EPOCH_PIN=1792719118 ./jobs/q.sh 1536 r3x-eeffcc9 bash jobs/r3x.sh
# R3 (C=<commit>): the Helios CLI (debug) at a COMMITTED candidate (b93fcfd | eeffcc9); derived from r2.sh. Original R2 header:
# R2: witness-check (debug) at the COMMITTED ef320298, at the ORIGINAL absolute paths of the build that produced the pin 4fe0cd3b
# (witness-failover/jobs/helper-build-test-r5.sh: same env, flags and command). A private mount namespace places a FRESH clean clone
# over witness-failover/helios, a FRESH empty dir over witness-failover/target and a private COPY over witness-failover/cargo-home,
# and makes witness-failover/vendor-inspect read-only. The real tree, target and cache are never written (verified before/after).
set -uo pipefail
. "$(dirname "$0")/inputs.sh"
C=${C:?commit}; W=$B/rpc-priority; SDE=${SOURCE_DATE_EPOCH_PIN:?epoch}; X=$R/r3x-${C:0:7}${VERIFY_ONLY:+-verify}; P=cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0
if [ "${1:-}" != inner ]; then
  offline; toolchain
  echo "== pre: originals"
  need "fresh $X" [ ! -e "$X" ]
  need "original helios-patched HEAD eeffcc9" [ "$(git -C $W/helios-patched rev-parse HEAD)" = eeffcc980a4a9aa092e23e07b1077c1f3fdfc95e ]
  T=$(git -C $W/helios-patched rev-parse "$C^{tree}"); L=$(git -C $W/helios-patched show "$C:Cargo.lock" | sha256sum | cut -c1-64); echo "[pre] candidate $C tree $T Cargo.lock $L"
  need "original helios repo clean" [ -z "$(git -C $W/helios-patched status --porcelain --untracked-files=all)" ]
  need "original target binary == pin" [ "$(sha256sum < $W/helios-target-base/debug/helios | cut -c1-64)" = $P ]
  CH0=$(treehash $W/cargo-home); VI0=$(treehash $W/vendor-inspect); echo "[pre] cargo-home manifest $CH0; vendor-inspect manifest $VI0"
  mkdir -p $X
  git clone -q --no-local --no-hardlinks --no-checkout $W/helios-patched $X/helios-patched && git -C $X/helios-patched -c advice.detachedHead=false checkout -q --detach "$C"
  need "clone: candidate tree" [ "$(git -C $X/helios-patched rev-parse HEAD^{tree})" = "$T" ]
  need "clone: clean" [ -z "$(git -C $X/helios-patched status --porcelain --untracked-files=all)" ]
  need "clone: Cargo.lock == the commit's" [ "$(sha256sum < $X/helios-patched/Cargo.lock | cut -c1-64)" = "$L" ]
  cp -a $W/cargo-home $X/cargo-home; need "cargo-home copy == original" [ "$(treehash $X/cargo-home)" = "$CH0" ]
  mkdir -p $X/target
  C=$C SOURCE_DATE_EPOCH_PIN=$SDE unshare -m --propagation private bash "$0" inner; irc=$?
  echo "== post: originals unchanged"
  need "original helios-patched HEAD unchanged" [ "$(git -C $W/helios-patched rev-parse HEAD)" = eeffcc980a4a9aa092e23e07b1077c1f3fdfc95e ]
  need "original helios repo still clean" [ -z "$(git -C $W/helios-patched status --porcelain --untracked-files=all)" ]
  need "original target binary still == pin" [ "$(sha256sum < $W/helios-target-base/debug/helios | cut -c1-64)" = $P ]
  need "original cargo-home unchanged" [ "$(treehash $W/cargo-home)" = "$CH0" ]
  need "vendor-inspect unchanged" [ "$(treehash $W/vendor-inspect)" = "$VI0" ]
  need "clone still clean after build" [ -z "$(git -C $X/helios-patched status --porcelain --untracked-files=all)" ]
  [ "${VERIFY_ONLY:-0}" = 1 ] && { echo "[verify] VERIFY_ONLY: namespace mounts and originals verified (inner rc=$irc); no compilation, no receipt"; exit $irc; }
  r=$(sha256sum < $X/target/debug/helios 2>/dev/null | cut -c1-64); echo "[result] rebuilt $r"; echo "[result] pin     $P"
  echo "$r  r3x-${C:0:7}/helios" > $R/receipts/r3x-${C:0:7}.sha256
  [ $irc -eq 0 ] || { echo "[r3 $C] build rc=$irc"; exit 1; }
  [ "$r" = "$P" ] && { echo "[result] REPRODUCED the pin from committed $C"; exit 0; } || { echo "[result] NOT equal to the pin (does not by itself prove the source differed)"; exit 1; }
fi
# ---- inner: private mount namespace -------------------------------------------------------------------------------------------
set -e
mount --bind $X/helios-patched $W/helios-patched; mount --bind $X/target $W/helios-target-base; mount --bind $X/cargo-home $W/cargo-home
mount --bind $W/vendor-inspect $W/vendor-inspect; mount -o remount,bind,ro $W/vendor-inspect
need "mounted: original path shows the clone (HEAD $C)" [ "$(git -C $W/helios-patched rev-parse HEAD)" = "$(git -C $X/helios-patched rev-parse HEAD)" ]
need "mounted: original target path is the empty fresh dir" [ -z "$(ls -A $W/helios-target-base)" ]
need "mounted: cargo-home path is the copy" [ "$(stat -c %i $W/cargo-home)" = "$(stat -c %i $X/cargo-home)" ]
need "mounted: vendor-inspect read-only" bash -c "! touch $W/vendor-inspect/.w 2>/dev/null"
[ "${VERIFY_ONLY:-0}" = 1 ] && { echo "[inner] VERIFY_ONLY: mounts verified; stopping before compilation"; exit 0; }
export RUSTUP_TOOLCHAIN=1.96.0 RUSTUP_AUTO_INSTALL=0 SOURCE_DATE_EPOCH=$SDE   # r3x: the pin's OpenSSL build stamp (mkbuildinf.pl reads it)
export CARGO_HOME=$W/cargo-home CARGO_TARGET_DIR=$W/helios-target-base CARGO_BUILD_JOBS=1 CARGO_NET_OFFLINE=true CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 RUSTFLAGS="-C link-arg=-Wl,--threads=1"
rustc --version; cd $W/helios-patched; git log --oneline -1; git status --short
echo "== build helios-cli ($C) $(date -u +%FT%TZ)"
timeout -k 10 5400 cargo build --offline -p helios-cli --bin helios
date -u +%FT%TZ; sha256sum $CARGO_TARGET_DIR/debug/helios
git diff --quiet Cargo.lock && echo "Cargo.lock unchanged" || { echo "Cargo.lock CHANGED"; exit 4; }
