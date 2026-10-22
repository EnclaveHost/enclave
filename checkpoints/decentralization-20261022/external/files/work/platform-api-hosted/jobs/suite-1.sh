#!/bin/bash
# platform-api-hosted suite 1 (immutable; a new file per revision). Run through work/claude-test-queue.py --mib 768 from the
# candidate tree. Every step runs; each step's own output goes to logs/suite-1/<step>.log and its exit code to
# logs/suite-1/<step>.rc; the job fails if any step failed.
set -euo pipefail
C=/home/steven/Documents/Codex/2026-10-18/wo/work/platform-api-hosted
L=$C/logs/suite-1
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
step bundle-build node scripts/build-platform-api-guest-bundle.mjs
step bundle-check node scripts/build-platform-api-guest-bundle.mjs --check
step replica node --test --test-concurrency=1 test/platform-api-replica.test.mjs
step config node --test --test-concurrency=1 test/platform-api-config.test.mjs
step registry node --test --test-concurrency=1 test/platform-api-registry.test.mjs
step hosted node --test --test-concurrency=1 test/platform-api-hosted.test.mjs
step measured-control-compat node --test --test-concurrency=1 test/metal-measured-control.test.mjs
echo "suite-1 fail=$fail"
exit "$fail"
