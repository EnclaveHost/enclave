#!/usr/bin/env bash
# make-testtree.sh <out dir> <bundle file>: a READ-ONLY-BY-CONVENTION symlink tree over the frozen lease-readiness tree (the source of
# the deployed control: windows/node/host.mjs 9634cb40, supervisor.js, test helpers) where ONLY these are real files:
#   windows/node/host-admission.bundle.mjs = <bundle file> (the candidate 40e8ba71, or the live 6bef372d as the old negative control)
#   network/host-service-gate-carriers.mjs, network/host-admission-node.mjs (the new sources, for source-level checks)
#   test/*.test.mjs of this package
# Tests run with NODE_OPTIONS=--preserve-symlinks --preserve-symlinks-main, so every module keeps its path INSIDE this tree and
# host.mjs / supervisor.js load the bundle placed here. Nothing writes into the tree: the tests use their own temp dirs.
set -euo pipefail
OUT="$1"; BUNDLE="$2"; P=$(cd "$(dirname "$0")/.." && pwd); L=/home/steven/Documents/Codex/2026-10-18/wo/work/lease-readiness-20261022/tree
[ -f "$L/windows/node/host.mjs" ] && [ "$(sha256sum "$L/windows/node/host.mjs" | cut -c1-8)" = 9634cb40 ] || { echo "the lease-readiness host.mjs is not 9634cb40"; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT"/{network,windows/node,test}
for e in "$L"/* "$L"/.[!.]*; do [ -e "$e" ] || continue; n=$(basename "$e"); case "$n" in network|windows|test) ;; *) ln -s "$e" "$OUT/$n";; esac; done
for e in "$L"/network/* "$L"/network/.[!.]*; do [ -e "$e" ] || [ -L "$e" ] || continue; ln -s "$e" "$OUT/network/$(basename "$e")"; done
for e in "$L"/windows/*; do n=$(basename "$e"); [ "$n" = node ] || ln -s "$e" "$OUT/windows/$n"; done
for e in "$L"/windows/node/* "$L"/windows/node/.[!.]*; do [ -e "$e" ] || [ -L "$e" ] || continue; n=$(basename "$e"); [ "$n" = host-admission.bundle.mjs ] || ln -s "$e" "$OUT/windows/node/$n"; done
cp "$BUNDLE" "$OUT/windows/node/host-admission.bundle.mjs"
cp "$P/src/network/host-service-gate-carriers.mjs" "$P/src/network/host-admission-node.mjs" "$OUT/network/"
ln -s "$L/test/helpers" "$OUT/test/helpers"
for t in host-admission-runtime host-admission-retry windows-node-platform-policy windows-node-wallet-network-hold platform-host-policy-process; do ln -s "$L/test/$t.test.mjs" "$OUT/test/$t.test.mjs"; done
cp "$P"/test/*.test.mjs "$OUT/test/"
echo "tree $OUT bundle $(sha256sum "$OUT/windows/node/host-admission.bundle.mjs" | cut -c1-8)"
