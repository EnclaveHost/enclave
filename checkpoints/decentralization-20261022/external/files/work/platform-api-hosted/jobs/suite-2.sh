#!/bin/bash
# platform-api-hosted suite 2 (immutable): suite 1 after the review fixes (bound replica protocol, output commit, client
# address, block-number cache), plus every existing suite that reads the measured-control guest, gsup or the image builder.
# The suites that read git history run with a scoped read-only GIT_DIR of main (root-endorsed). Run through
# work/claude-test-queue.py --mib 768 from the candidate tree. Each step: logs/suite-2/<step>.log and .rc; fails if any did.
set -euo pipefail
C=/home/steven/Documents/Codex/2026-10-18/wo/work/platform-api-hosted
L=$C/logs/suite-2
mkdir -p "$L"
cd "$C/tree"
fail=0
step() {
  local name=$1; shift
  set +e
  "$@" > "$L/$name.log" 2>&1
  local rc=$?
  set -e
  echo "$rc" > "$L/$name.rc"
  echo "step $name rc=$rc"
  if [ "$rc" -ne 0 ]; then fail=1; fi
}
G=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git
step bundle-build node scripts/build-platform-api-guest-bundle.mjs
step bundle-check node scripts/build-platform-api-guest-bundle.mjs --check
step replica node --test --test-concurrency=1 test/platform-api-replica.test.mjs
step config node --test --test-concurrency=1 test/platform-api-config.test.mjs
step registry node --test --test-concurrency=1 test/platform-api-registry.test.mjs
step hosted node --test --test-concurrency=1 test/platform-api-hosted.test.mjs
step compat-measured-control env GIT_DIR="$G" node --test --test-concurrency=1 test/metal-measured-control.test.mjs
step compat-launcher-isolation env GIT_DIR="$G" node --test --test-concurrency=1 test/metal-launcher-isolation.test.mjs
step compat-lease-gas-conduit env GIT_DIR="$G" node --test --test-concurrency=1 test/metal-lease-gas-conduit.test.mjs
step compat-shielded-build env GIT_DIR="$G" node --test --test-concurrency=1 test/metal-shielded-build.test.mjs
step compat-shielded-fault-logs env GIT_DIR="$G" node --test --test-concurrency=1 test/shielded-fault-logs.test.mjs
step compat-shielded-multi-card env GIT_DIR="$G" node --test --test-concurrency=1 test/shielded-multi-card.test.mjs
step compat-tenant-eligibility env GIT_DIR="$G" node --test --test-concurrency=1 test/tenant-compute-eligibility.test.mjs
echo "suite-2 fail=$fail"
exit "$fail"
