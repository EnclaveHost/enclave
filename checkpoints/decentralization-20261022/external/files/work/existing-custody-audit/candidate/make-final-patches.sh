#!/bin/bash
# After make-final.sh and the bundle rebuild: core.patch (pristine main -> after-core) and callsites.patch (after-core ->
# final), each over exactly the files that differ; then both are applied in order to a fresh copy of main with --check.
set -euo pipefail
C=/home/steven/Documents/Codex/2026-10-18/wo/work/existing-custody-audit/candidate; F=$C/final
changed() { (cd $1 && find . -path ./node_modules -prune -o -path '*/node_modules' -prune -o -type f -print | sort) > /tmp/a.lst
            (cd $2 && find . -path ./node_modules -prune -o -path '*/node_modules' -prune -o -type f -print | sort) > /tmp/b.lst
            sort -u /tmp/a.lst /tmp/b.lst | while read f; do f=${f#./}; if [ ! -e "$1/$f" ] || [ ! -e "$2/$f" ] || ! cmp -s "$1/$f" "$2/$f"; then echo "$f"; fi; done; }
mk() { local A=$1 B=$2 P=$3; : > $P; for f in $(changed $A $B); do
    if [ -e "$A/$f" ]; then diff -u --label "a/$f" --label "b/$f" "$A/$f" "$B/$f" >> $P || true
    else diff -u --label /dev/null --label "b/$f" /dev/null "$B/$f" >> $P || true; fi; done; }
mk $F/pristine $F/after-core $F/core.patch
mk $F/after-core $F/main $F/callsites.patch
rm -rf $F/check && cp -r $F/pristine $F/check
(cd $F/check && git apply --check $F/core.patch && git apply $F/core.patch && git apply --check $F/callsites.patch && git apply $F/callsites.patch && echo "BOTH PATCHES APPLY IN ORDER")
for f in $(changed $F/check $F/main); do echo "MISMATCH after apply: $f"; done
{ for p in core callsites; do echo "$(sha256sum $F/$p.patch | cut -c1-64)  $p.patch  files=$(grep -c '^+++ b/' $F/$p.patch)"; done
  echo; echo "core.patch files:"; grep '^+++ b/' $F/core.patch | sed 's#^+++ b/#  #'
  echo "callsites.patch files:"; grep '^+++ b/' $F/callsites.patch | sed 's#^+++ b/#  #'
  echo; echo "base (pristine main) sha256 of every modified file:"
  for f in $(grep '^--- a/' $F/core.patch $F/callsites.patch | sed 's#.*--- a/##' | sort -u); do echo "  $(sha256sum $F/pristine/$f | cut -c1-64)  $f"; done
  echo; echo "result sha256 of every changed file:"
  for f in $(grep -h '^+++ b/' $F/core.patch $F/callsites.patch | sed 's#^+++ b/##' | sort -u); do echo "  $(sha256sum $F/main/$f | cut -c1-64)  $f"; done
} > $F/PATCHES.txt
cat $F/PATCHES.txt | head -8
# source-only variant (generated bundles excluded; root rebuilds them: node scripts/build-host-admission.mjs; (cd relay && node build-network.mjs))
python3 - $F/callsites.patch $F/callsites-source.patch <<'PY'
import sys,re
s=open(sys.argv[1]).read()
parts=re.split(r'(?m)^(?=--- (?:a/|/dev/null))',s)
open(sys.argv[2],'w').write(''.join(p for p in parts if p and not re.search(r'(?m)^\+\+\+ b/\S*bundle\.mjs(\.manifest\.json)?$',p)))
PY
echo "$(sha256sum $F/callsites-source.patch | cut -c1-64)  callsites-source.patch  files=$(grep -c '^+++ b/' $F/callsites-source.patch)  (callsites.patch minus the 4 generated bundle files)" >> $F/PATCHES.txt
