#!/usr/bin/env bash
# New isolated tree from IMMUTABLE 4106c311 (my final-compose repo, read only) + A's objects through df8fbafae (read only).
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-rpc-closure
F=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-services-final-compose/candidate
A=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority/repo
cd "$HERE"; [ ! -e candidate ]
git clone -q --local --no-hardlinks --no-checkout "$F" candidate
cd candidate; git remote remove origin
git checkout -q -b closure/host-service-rpc 4106c3114dd13f39692195c182d3152efa5e212c
git fetch -q "$A" df8fbafae081321f3c9a9c774e41007200913f32
[ "$(git rev-parse FETCH_HEAD)" = df8fbafae081321f3c9a9c774e41007200913f32 ]; git update-ref refs/a/df8fbafae FETCH_HEAD
git config core.hooksPath .githooks
for d in node_modules network/node_modules relay/node_modules e2e/node_modules sdk/sessions/node_modules; do [ -d "$F/$d" ] && cp -a "$F/$d" "$d"; done
mkdir -p contracts/foundry; cp -a "$F/contracts/foundry/out" contracts/foundry/out
git rev-parse HEAD; git status --porcelain | head; echo SETUP_OK
