#!/bin/bash
# Policy-mirror follow-on, composed on the hosted-placement tree (work/hosted-service-placement/policy-tree): packages built
# then checked current, the real-gate cold-start/ban/unban test and the placement test on real local chains (anvil), and
# the existing suites of every module this follow-on touches or depends on.
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/hosted-service-placement/policy-tree
node scripts/build-host-service-packages.mjs
node scripts/build-host-service-packages.mjs --check
echo PACKAGES-OK
node --test --test-concurrency=1 test/hosted-policy-cold-start.test.mjs
echo POLICY-E2E-OK
node --test --test-concurrency=1 test/hosted-service-placement.test.mjs
echo PLACEMENT-E2E-OK
node --test --test-concurrency=1 test/transport-profile.test.mjs test/public-directory.test.mjs test/bootstrap-gateway.test.mjs \
  test/service-index-quorum.test.mjs test/service-index-rpc-config.test.mjs test/host-policy-enforcement.test.mjs \
  test/platform-host-policy.test.mjs test/host-policy-callsites.test.mjs test/platform-policy-mirror-bounds.test.mjs
echo EXISTING-OK
# service-index.test.mjs reads one historical contract from git: main's repository, read-only
GIT_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git node --test --test-concurrency=1 test/service-index.test.mjs
echo SERVICE-INDEX-OK
