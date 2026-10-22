#!/bin/bash
# FINAL hs2 against final main (credit integration landed 07:44Z): tree-r3 = final main + this work's patch. The tree's
# packages must be CURRENT (no --allow-stale-packages); APP_STATIC re-tested on the regenerated route-dns package; both
# archives built and rebuilt byte-identically; the Linux archive test on the final archive.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/hosted-services-activation
cd "$H"
fails=0
step() { local name=$1; shift; echo "=== STEP $name"; if "$@"; then echo "=== $name OK"; else echo "=== $name FAILED ($?)"; fails=$((fails+1)); fi; }
step PACKAGES-CURRENT env -C "$H/tree-r3" node scripts/build-host-service-packages.mjs --check
step APP-STATIC-TEST env -C "$H/tree-r3" node --test --test-concurrency=1 test/hosted-services-appstatic.test.mjs
step BUILD-FINAL node build-stage-r2.mjs --tree tree-r3
step REPRODUCIBLE-FINAL node build-stage-r2.mjs --tree tree-r3 --check
step ARCHIVE-TEST-FINAL env -C "$H/tree-r3" STAGE_TAR="$H/out/enclave-host-services-hs2.tar" node --test --test-concurrency=1 test/hosted-services-stage.test.mjs
echo "=== FAILED STEPS: $fails"
[ "$fails" -eq 0 ]
