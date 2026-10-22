#!/bin/bash
# ROOT, ONCE, after the credit worker's integration (kind 8 + regenerated route-DNS packages) has landed in main, AND this
# work's patch (patches-r2/02-appstatic-windows-refresh.patch) is integrated. Builds the FINAL hs2 archives against final
# main's package pins. Run through the queue (esbuild): python3 ../claude-test-queue.py --mib 768 -- ./refresh-final.sh
#   ./refresh-final.sh [--app-static app-static.json]    (the output of scripts/capture-app-static.sh, if captured)
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/hosted-services-activation; M=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
cd "$H"
# 1. a fresh copy of FINAL main (real node_modules, no .git), and proof that this work's files are in it unchanged
rm -rf tree-final; rsync -a --exclude=.git "$M/" tree-final/
while read -r want f; do [ "$(sha256sum < "tree-final/$f" | cut -d' ' -f1)" = "$want" ] || { echo "main does not carry this work's $f (integrate patches-r2 first)"; exit 3; }; done < patches-r2/FILES.sha256.src
# 2. its packages must be CURRENT with its sources (this is what makes the pins final)
(cd tree-final && node scripts/build-host-service-packages.mjs --check)
# 3. the archives, then a byte-identical rebuild
node build-stage-r2.mjs --tree tree-final "$@"
node build-stage-r2.mjs --tree tree-final "$@" --check
cat out/enclave-host-services-hs2.tar.sha256 out/enclave-host-services-hs2-windows.tar.sha256
