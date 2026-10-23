#!/bin/bash
set -u; cd "$(dirname "$0")" || exit 2
export HOLDER_NVME_SCRATCH=${HOLDER_NVME_SCRATCH:-/home/steven/Documents/Codex/2026-10-18/wo/work/fresh-witness-supply/test-scratch}
export B_REPO=${B_REPO:-/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-runtime-composition/repo}
exec timeout -k 10 "${JOB_SEC:-500}" unshare --user --map-root-user --net sh -c 'ip link set lo up && exec python3 -I test/mutate.py'
