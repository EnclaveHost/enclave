#!/bin/bash
# The feature-completion BASE: the FROZEN android-independent-host candidate tree, copied (never edited in place).
# pristine/ = that base; tree/ = where this work's changes go. Real copies of every node_modules (cp -a of a tree that holds
# real copies), contracts/foundry/out stays the read-only link the candidate already had.
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/android-feature-completion
C=/home/steven/Documents/Codex/2026-10-18/wo/work/android-independent-host
E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
[ ! -e $H/pristine ] || { echo "pristine exists: refusing to overwrite" >&2; exit 2; }
cp -a $C/tree $H/pristine
{ date -Is; echo "frozen candidate: $C/tree (patch sha256 $(sha256sum $C/android-independent-host.patch | cut -c1-64), MANIFEST sha256 $(sha256sum $C/MANIFEST.json | cut -c1-64))";
  sed 's/^/candidate base: /' $C/BASE.txt; echo "main HEAD now $(git -C $E rev-parse HEAD)"; echo "main status sha256 now $(git -C $E status --short | sha256sum | cut -c1-64)"; } > $H/BASE.txt
cp -a $H/pristine $H/tree
echo done
