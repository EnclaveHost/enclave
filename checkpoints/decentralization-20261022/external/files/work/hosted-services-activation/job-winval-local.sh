#!/bin/bash
# Windows-validation fixtures: bundle, then prove them LOCALLY (Linux) before any minipc run.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/hosted-services-activation
cd "$H/winval"
node build.mjs || exit 1
cp src/harness-local.mjs dist/harness-local.mjs
node dist/harness-local.mjs "$H/stage-r2/enclave-host-services-hs2" "$H/capture/app-static.json"
