#!/bin/sh
# Hosted service placement: the host-service packages built (esbuild) then checked current, the new end-to-end test on a
# real local chain (anvil), and the existing suites of the modules the roles package (unchanged here).
set -e
cd /home/steven/Documents/Codex/2026-10-18/wo/work/hosted-service-placement/tree
node scripts/build-host-service-packages.mjs
node scripts/build-host-service-packages.mjs --check
echo PACKAGES-OK
node --test --test-concurrency=1 test/hosted-service-placement.test.mjs
echo E2E-OK
node --test --test-concurrency=1 test/transport-profile.test.mjs test/public-directory.test.mjs test/bootstrap-gateway.test.mjs
echo EXISTING-OK
