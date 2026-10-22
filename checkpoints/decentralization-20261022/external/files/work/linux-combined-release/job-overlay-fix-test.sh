#!/bin/sh
# Overlay symlink fix: run the overlay suite on a CLONE of v1's scratch commit 0080dc024 (main's captured working tree):
# A = 0080dc024 as is (old tool + old suite), B' = child of A with ONLY metal/overlay-control-image.py and
# test/metal-control-overlay.test.py replaced by overlay-fix/new/*. Nothing written in main or in stage/scratch.git.
set -e
L=/home/steven/Documents/Codex/2026-10-18/wo/work/linux-combined-release; F=$L/overlay-fix; T=$F/testrepo
A=0080dc0247f04af9bb87b2eaa1d6d7d65582a65b
[ ! -e $T ] || { echo "testrepo exists; inspect"; exit 2; }
git clone -q --no-hardlinks --no-checkout $L/stage/scratch.git $T
cd $T
for p in metal/overlay-control-image.py test/metal-control-overlay.test.py; do
  b=$(basename $p); [ "$(git show $A:$p | sha256sum | cut -c1-64)" = "$(sha256sum < $F/base/$b | cut -c1-64)" ] || { echo "A's $p != overlay-fix/base"; exit 1; }
done; echo "A-CARRIES-THE-FIX-BASE"
git -c advice.detachedHead=false checkout -q $A
echo "== OLD suite at A"; python3 test/metal-control-overlay.test.py -v 2>&1 | tail -25 || true
cp $F/new/metal/overlay-control-image.py metal/; cp $F/new/test/metal-control-overlay.test.py test/
git add metal/overlay-control-image.py test/metal-control-overlay.test.py
git -c user.name=stage -c user.email=stage@localhost commit -q -m "overlay: install a git symlink's in-repo target bytes (build-image.mjs parity), never the link text"
B=$(git rev-parse HEAD); echo "B' $B parent $(git rev-parse HEAD^)"; git diff --stat $A $B
echo "== NEW suite at B'"; python3 test/metal-control-overlay.test.py -v
echo OVERLAY-FIX-SUITE-OK
