#!/bin/sh
# make-patches.sh: this work's delta against CURRENT main (work/enclave working copy), read-only towards main.
# Base: the snapshot of main taken at the start (base/main-tree.sha256). Every file this work touches must still be
# byte-identical in main to that snapshot, else it refuses; files main changed on its own are listed, not patched.
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; M=$W/enclave; L=$W/linux-lease-activation; T=$L/tree; P=$L/patches
sum() { [ -e "$1" ] && sha256sum < "$1" | cut -c1-64 || echo NEW; }
rm -rf $P; mkdir -p $P
cd $T
find . -type f -not -path '*/node_modules/*' -not -path '*/__pycache__/*' | sed 's#^\./##' | sort > $L/base/.files
awk '{print $2}' $L/base/main-tree.sha256 | sed 's#^\./##' | sort > $L/base/.basefiles
: > $L/base/.delta; : > $L/base/main-moved.txt
while read f; do
  b=$(grep -F "  ./$f" $L/base/main-tree.sha256 | grep -E "  \./$(printf '%s' "$f" | sed 's/[.[\*^$]/\\&/g')\$" | cut -c1-64)
  [ -z "$b" ] && b=NEW
  [ "$(sum $T/$f)" = "$b" ] || echo "$f" >> $L/base/.delta
done < $L/base/.files
while read f; do [ -e "$T/$f" ] || echo "$f" >> $L/base/.delta; done < $L/base/.basefiles
: > $P/INVENTORY.txt
while read f; do
  case "$f" in __pycache__/*|*/__pycache__/*) continue;; esac
  base=$(grep -E "  \./$(printf '%s' "$f" | sed 's/[.[\*^$]/\\&/g')\$" $L/base/main-tree.sha256 | cut -c1-64); [ -z "$base" ] && base=NEW
  [ "$(sum $M/$f)" = "$base" ] || { echo "MAIN MOVED UNDER A TOUCHED FILE: $f"; exit 1; }
  case "$f" in test/*) a=02-tests ;; *.bundle.mjs|*.bundle.mjs.manifest.json) a=03-generated-bundle ;; *) a=01-metal-lease-gas-conduit ;; esac
  if [ -e "$M/$f" ]; then diff -u --label "a/$f" --label "b/$f" "$M/$f" "$T/$f" >> $P/$a.patch || true
  else diff -u --label /dev/null --label "b/$f" /dev/null "$T/$f" >> $P/$a.patch || true; fi
  printf '%s.patch  %s  %s  %s\n' $a $base $(sum $T/$f) "$f" >> $P/INVENTORY.txt
done < $L/base/.delta
# main's own movement since the snapshot, in files this work does not touch
while read h f; do f=${f#./}; grep -qxF "$f" $L/base/.delta && continue; [ "$(sum $M/$f)" = "$h" ] || echo "$(sum $M/$f) $h $f" >> $L/base/main-moved.txt; done < $L/base/main-tree.sha256
git -C $M rev-parse HEAD > $L/base/main-head-at-delivery.txt
rm -f $L/base/.files $L/base/.basefiles $L/base/.delta
(cd $P && sha256sum *.patch INVENTORY.txt > SHA256SUMS)
cat $P/INVENTORY.txt; wc -l $P/*.patch; echo "main moved (untouched files): $(wc -l < $L/base/main-moved.txt)"
