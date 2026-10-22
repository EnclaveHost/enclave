#!/bin/bash
# Policy-mirror follow-on composed on the hosted-placement tree (policy-tree), run 3: every step runs and reports, the job
# fails if any did. Packages built then checked current; the real-gate cold-start/ban/unban test and the placement test on
# real local chains (anvil); the existing suites of every module this work touches or depends on.
set -uo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/hosted-service-placement/policy-tree
fails=0
step() { local name=$1; shift; echo "=== STEP $name"; if "$@"; then echo "=== $name OK"; else echo "=== $name FAILED ($?)"; fails=$((fails+1)); fi; }
step PACKAGES-BUILD node scripts/build-host-service-packages.mjs
step PACKAGES-CHECK node scripts/build-host-service-packages.mjs --check
step POLICY-E2E node --test --test-concurrency=1 test/hosted-policy-cold-start.test.mjs
step PLACEMENT-E2E node --test --test-concurrency=1 test/hosted-service-placement.test.mjs
step EXISTING node --test --test-concurrency=1 test/transport-profile.test.mjs test/public-directory.test.mjs test/bootstrap-gateway.test.mjs \
  test/service-index-quorum.test.mjs test/service-index-rpc-config.test.mjs test/host-policy-enforcement.test.mjs \
  test/platform-host-policy.test.mjs test/host-policy-callsites.test.mjs test/platform-policy-mirror-bounds.test.mjs
# service-index.test.mjs reads one historical contract from git: main's repository, read-only
step SERVICE-INDEX env GIT_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git node --test --test-concurrency=1 test/service-index.test.mjs
echo "=== FAILED STEPS: $fails"
[ "$fails" -eq 0 ]
