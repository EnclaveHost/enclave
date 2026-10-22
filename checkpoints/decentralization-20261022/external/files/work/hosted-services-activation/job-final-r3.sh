#!/bin/bash
# FINAL archives after W2/W9 (hs2 label, same pins and tree-final): built into final-r3/ (out/ = the previous finals,
# untouched), byte-identical rebuild, then the APP_STATIC test and the Linux archive test on the NEW Linux archive, and
# the Windows-fixture local regression (harness-local, positional fixture mode).
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/hosted-services-activation
cd "$H"
fails=0
step() { local name=$1; shift; echo "=== STEP $name"; if "$@"; then echo "=== $name OK"; else echo "=== $name FAILED ($?)"; fails=$((fails+1)); fi; }
sha256sum out/enclave-host-services-hs2.tar out/enclave-host-services-hs2-windows.tar
while read -r want f; do [ "$(sha256sum < "tree-final/$f" | cut -d' ' -f1)" = "$want" ] || { echo "tree-final drifted: $f"; exit 3; }; done < patches-r2/FILES.sha256.src
step PACKAGES-CURRENT env -C tree-final node scripts/build-host-service-packages.mjs --check
step BUILD-FINAL-R3 node build-stage-r2.mjs --tree tree-final --app-static capture/app-static.json --out final-r3
step REPRODUCIBLE-FINAL-R3 node build-stage-r2.mjs --tree tree-final --app-static capture/app-static.json --out final-r3 --check
step APP-STATIC-TEST env -C tree-final node --test --test-concurrency=1 test/hosted-services-appstatic.test.mjs
step ARCHIVE-TEST-FINAL-R3 env -C tree-final STAGE_TAR="$H/final-r3/out/enclave-host-services-hs2.tar" node --test --test-concurrency=1 test/hosted-services-stage.test.mjs
step WINVAL-LOCAL ./job-winval-local.sh
cat final-r3/out/*.sha256
sha256sum out/enclave-host-services-hs2.tar out/enclave-host-services-hs2-windows.tar
echo "=== FAILED STEPS: $fails"
[ "$fails" -eq 0 ]
