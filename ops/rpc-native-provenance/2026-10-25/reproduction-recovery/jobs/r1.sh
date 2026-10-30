#!/usr/bin/env bash
# R1: the RELEASE listener twice from the recorded recipe (build-binaries.sh release listener; commit 5e178676; base tarball 9784e20a),
# fresh work dirs A and B, each with a fresh private COPY of the listener cargo home (the original is never written). Expect 9ca75047.
set -uo pipefail
. "$(dirname "$0")/inputs.sh"; rc=0
offline; toolchain
echo "== pre: inputs"
need "build-binaries.sh d5bb17e8" [ "$(sha256sum < $SCRIPT | cut -c1-8)" = d5bb17e8 ]
need "base tarball 9784e20a" [ "$(sha256sum < $TAR | cut -c1-64)" = 9784e20a3cfeac555d96e8d1f15526d5264f0e6d8885b951c6f1220355038012 ]
need "listener 5e178676 tree 00e3a61d" [ "$(git -C $LREPO rev-parse '5e178676^{tree}')" = 00e3a61d48c91a6072355bf0ac67564490a6fc8b ]
need "helios ef320298 tree eec339e1 (exported by the script)" [ "$(git -C $HREPO rev-parse 'ef320298^{tree}')" = eec339e18296d850a514f72de2efdd8729302efd ]
LS0=$(git -C $LREPO status --porcelain --untracked-files=all | sha256sum | cut -c1-16); HS0=$(git -C $HREPO status --porcelain --untracked-files=all | sha256sum | cut -c1-16)
echo "[pre] listener repo HEAD $(git -C $LREPO rev-parse HEAD) status-digest $LS0; helios repo HEAD $(git -C $HREPO rev-parse HEAD) status-digest $HS0"
CH0=$(treehash $CHL); echo "[pre] original listener cargo home manifest $CH0 ($(find $CHL -type f | wc -l) files)"
for side in a b; do
  W=$R/r1/work-$side; H=$R/r1/cargo-home-$side
  need "fresh $side" [ ! -e "$W" ] && [ ! -e "$H" ]
  mkdir -p $R/r1; cp -a $CHL $H; need "copy $side == original" [ "$(treehash $H)" = "$CH0" ]
  echo "== build $side $(date -u +%FT%TZ)"
  LISTENER_CARGO_HOME=$H bash $SCRIPT $W $HREPO $LREPO $TAR $H release listener > $R/logs/r1-build-$side.out 2>&1; brc=$?
  tail -3 $R/logs/r1-build-$side.out; echo "[build $side] rc=$brc $(date -u +%FT%TZ)"
  [ $brc -eq 0 ] || rc=1
  sha256sum $W/target-listener/release/enclave-base-head-listener 2>/dev/null | sed "s#  .*#  r1-$side/enclave-base-head-listener#" | tee -a $R/receipts/r1.sha256
done
echo "== post: inputs unchanged"
need "original cargo home unchanged" [ "$(treehash $CHL)" = "$CH0" ]
need "listener repo status unchanged" [ "$(git -C $LREPO status --porcelain --untracked-files=all | sha256sum | cut -c1-16)" = "$LS0" ]
need "helios repo status unchanged" [ "$(git -C $HREPO status --porcelain --untracked-files=all | sha256sum | cut -c1-16)" = "$HS0" ]
a=$(sha256sum < $R/r1/work-a/target-listener/release/enclave-base-head-listener 2>/dev/null | cut -c1-64); b=$(sha256sum < $R/r1/work-b/target-listener/release/enclave-base-head-listener 2>/dev/null | cut -c1-64)
P=9ca75047ab9ee4f2c44a211b237aa5a8171af1661b17047aafaf2e9b63d10ba3
echo "[result] A $a"; echo "[result] B $b"; echo "[result] pin $P"
[ -n "$a" ] && [ "$a" = "$b" ] && echo "[result] A == B" || { echo "[result] A != B"; rc=1; }
[ "$a" = "$P" ] && echo "[result] REPRODUCED the pin" || { echo "[result] NOT equal to the pin"; rc=1; }
echo "[r1] rc=$rc"; exit $rc
