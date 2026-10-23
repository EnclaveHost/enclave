#!/bin/bash
# build r5 then (only if it passes) the head-path E2E, as ONE queued job
set -euo pipefail
J=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority/jobs
$J/base-evm-build-test-r5.sh
echo "== head-path E2E"
$J/base-head-e2e-r1.sh
