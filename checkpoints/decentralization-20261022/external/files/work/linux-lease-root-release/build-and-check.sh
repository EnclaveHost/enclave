#!/bin/sh
set -eu
base=/home/steven/Documents/Codex/2026-10-18/wo/work/linux-lease-root-release
cd "$base/tree"
node scripts/build-host-admission.mjs
node scripts/build-host-admission.mjs --check
node scripts/build-metal-lease-gas.mjs --check
node --test test/metal-lease-gas-conduit.test.mjs test/metal-measured-control.test.mjs
sh "$base/job-stage.sh"
sh "$base/job-release.sh"
