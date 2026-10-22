#!/bin/bash
# hs2 (APP_STATIC parity, Windows supervision, refreshable stage), Node side: the targeted APP_STATIC test (real DNS from
# the pinned route-dns package), the hs2 archives built from tree-r2 (= current main + this work's patch; packages are
# stale in current main until the credit integration, so --allow-stale-packages: a TEST build, recorded as such) and
# re-built byte-identically, and the Linux archive test (runner/roles/tool changed) on the hs2 archive.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/hosted-services-activation
cd "$H"
fails=0
step() { local name=$1; shift; echo "=== STEP $name"; if "$@"; then echo "=== $name OK"; else echo "=== $name FAILED ($?)"; fails=$((fails+1)); fi; }
step APP-STATIC-TEST env -C "$H/tree-r2" node --test --test-concurrency=1 test/hosted-services-appstatic.test.mjs
step BUILD-R2 node build-stage-r2.mjs --tree tree-r2 --allow-stale-packages
step REPRODUCIBLE-R2 node build-stage-r2.mjs --tree tree-r2 --allow-stale-packages --check
step ARCHIVE-TEST-R2 env -C "$H/tree-r2" STAGE_TAR="$H/out/enclave-host-services-hs2.tar" node --test --test-concurrency=1 test/hosted-services-stage.test.mjs
echo "=== FAILED STEPS: $fails"
[ "$fails" -eq 0 ]
