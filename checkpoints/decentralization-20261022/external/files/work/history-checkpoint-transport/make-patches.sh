#!/bin/sh
# make-patches.sh: the deliverables of work/history-checkpoint-transport, read-only towards main and the previous tree.
# Base: the previous TESTED tree (work/history-owner-tools/tree, verified unchanged: base/prev-tree.sha256). Root has
# since integrated all 21 files of the previous delivery into main's working copy (base/main-state.txt: INTEGRATED), so
# this delivery's delta applies to CURRENT main as is: every file it touches must be byte-identical in main and in the
# previous tree, else it refuses. Files main changed on its own since (not touched here) are listed, not patched.
#   patches/07-checkpoint-transport-guest.patch, 08-checkpoint-transport-tests.patch, 09-checkpoint-owner-tools.patch
#   patches/INVENTORY.txt  (patch, main/previous sha256 or NEW, result sha256, path); patches/SHA256SUMS
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; M=$W/enclave; H=$W/history-checkpoint-transport; T=$H/tree; PREV=$W/history-owner-tools/tree; P=$H/patches
(cd $PREV && sha256sum -c --quiet $H/base/prev-tree.sha256) || { echo "PREVIOUS TREE CHANGED"; exit 1; }
git -C $M rev-parse HEAD > $H/base/main-head.txt
sum() { [ -e "$1" ] && sha256sum < "$1" | cut -c1-64 || echo NEW; }
# the previous delivery's state in main
while read p h r f; do m=$(sum $M/$f); if [ "$m" = "$r" ]; then echo "INTEGRATED $f"; elif [ "$m" = "$h" ]; then echo "BASE $f"; else echo "DIVERGED $f"; fi; done \
  < $W/history-owner-tools/patches/INVENTORY.txt > $H/base/main-state.txt
rm -rf $P; mkdir -p $P
cd $T
find . -type f -not -path '*/node_modules/*' -not -path './.git/*' | sed 's#^\./##' | sort > $H/base/.files
: > $H/base/.delta; : > $H/base/main-moved.txt
while read f; do
  if ! { [ -e "$PREV/$f" ] && cmp -s "$PREV/$f" "$T/$f"; }; then echo "$f" >> $H/base/.delta
  elif ! { [ -e "$M/$f" ] && cmp -s "$M/$f" "$T/$f"; }; then echo "$(sum $M/$f) $(sum $T/$f) $f" >> $H/base/main-moved.txt; fi
done < $H/base/.files
: > $P/INVENTORY.txt
while read f; do
  [ "$(sum $M/$f)" = "$(sum $PREV/$f)" ] || { echo "MAIN DIFFERS FROM THE PREVIOUS TREE: $f"; exit 1; }
  case "$f" in
    isolation/m2/bootstrap/*_test.go|isolation/m2/bootstrap/testdata/*|isolation/m2/front/*_test.go|test/*) a=08-checkpoint-transport-tests ;;
    isolation/*) a=07-checkpoint-transport-guest ;;
    *) a=09-checkpoint-owner-tools ;;
  esac
  if [ -e "$M/$f" ]; then diff -u --label "a/$f" --label "b/$f" "$M/$f" "$T/$f" >> $P/$a.patch || true
  else diff -u --label /dev/null --label "b/$f" /dev/null "$T/$f" >> $P/$a.patch || true; fi
  printf '%s.patch  %s  %s  %s\n' $a $(sum $M/$f) $(sum $T/$f) "$f" >> $P/INVENTORY.txt
done < $H/base/.delta
rm -f $H/base/.files $H/base/.delta
(cd $P && sha256sum *.patch INVENTORY.txt > SHA256SUMS)
wc -l $P/*.patch; wc -l < $P/INVENTORY.txt; cat $H/base/main-moved.txt; grep -c INTEGRATED $H/base/main-state.txt
