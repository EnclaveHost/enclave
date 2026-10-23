#!/usr/bin/env bash
# Test prerequisite: the gitignored relay runtime bundle and the host-service packages, from THIS working tree (offline).
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-rpc-closure
cd "$H/candidate"; export TMPDIR="$H/tmp/t" PATH="$H/stubs:/usr/local/bin:/usr/bin:/bin"
timeout -k 10 400 unshare -rn --pid --fork --kill-child --mount-proc sh -c 'node relay/build-network.mjs && node scripts/build-host-service-packages.mjs | tail -2'
sha256sum relay/network-runtime.bundle.mjs network/host-services/packages/*.package.json
