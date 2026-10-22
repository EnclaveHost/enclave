#!/usr/bin/env bash
# make-testtree.sh <out dir> <bundle file> <measured-control.mjs>: a READ-ONLY-BY-CONVENTION symlink tree over the frozen
# lease-readiness tree (the source of supervisor.js 8a37ab6a, gsup.mjs, the test helpers). ONLY these are real files:
#   windows/node/host-admission.bundle.mjs = <bundle file>   (candidate 40e8ba71, or the installed 6bef372d for old negatives)
#   metal/guest/measured-control.mjs       = <measured-control.mjs> (this package's src, or the frozen base 18f47214)
#   test/*.test.mjs + test/helpers/*.mjs of this package
# Tests run with --preserve-symlinks so every module keeps its path INSIDE this tree. Nothing writes into the tree: the tests
# use their own temp dirs, and spawned supervisors run with a temp cwd.
set -euo pipefail
OUT="$1"; BUNDLE="$2"; MC="$3"; P=$(cd "$(dirname "$0")/.." && pwd); L=/home/steven/Documents/Codex/2026-10-18/wo/work/lease-readiness-20261022/tree
[ "$(sha256sum < "$L/supervisor.js" | cut -c1-8)" = 8a37ab6a ] || { echo "the lease-readiness supervisor.js is not 8a37ab6a"; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT"/{metal/guest,windows/node,test/helpers}
link_all() { local src="$1" dst="$2"; shift 2; for e in "$src"/* "$src"/.[!.]*; do [ -e "$e" ] || [ -L "$e" ] || continue; n=$(basename "$e"); case " $* " in *" $n "*) ;; *) ln -s "$e" "$dst/$n";; esac; done; }
link_all "$L" "$OUT" metal windows test
link_all "$L/metal" "$OUT/metal" guest
link_all "$L/metal/guest" "$OUT/metal/guest" measured-control.mjs
link_all "$L/windows" "$OUT/windows" node
link_all "$L/windows/node" "$OUT/windows/node" host-admission.bundle.mjs
link_all "$L/test" "$OUT/test" helpers
link_all "$L/test/helpers" "$OUT/test/helpers"
# --remove-destination: a copy REPLACES a link and never writes through it into the frozen tree (symlink-farm hazard)
cp --remove-destination "$BUNDLE" "$OUT/windows/node/host-admission.bundle.mjs"; cp --remove-destination "$MC" "$OUT/metal/guest/measured-control.mjs"
for f in "$P"/test/*.test.mjs; do cp --remove-destination "$f" "$OUT/test/$(basename "$f")"; done
for h in "$P"/test/helpers/*.mjs; do [ -e "$h" ] && cp --remove-destination "$h" "$OUT/test/helpers/$(basename "$h")"; done
for f in windows/node/host-admission.bundle.mjs metal/guest/measured-control.mjs; do [ -f "$OUT/$f" ] && [ ! -L "$OUT/$f" ] || { echo "$f is not a real file"; exit 1; }; done
echo "tree $OUT bundle $(sha256sum < "$OUT/windows/node/host-admission.bundle.mjs" | cut -c1-8) measured-control $(sha256sum < "$OUT/metal/guest/measured-control.mjs" | cut -c1-8)"
