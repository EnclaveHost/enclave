#!/bin/bash
# Stage-1 rollout archive (work/hosted-services-activation), run 1: build, reproducibility check, then the archive test in a
# dependency-free directory (production install/check/rollback, live anvil run, endpoint fix). Every step reports.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/hosted-services-activation
cd "$H"
fails=0
step() { local name=$1; shift; echo "=== STEP $name"; if "$@"; then echo "=== $name OK"; else echo "=== $name FAILED ($?)"; fails=$((fails+1)); fi; }
step BUILD node build-stage.mjs
step REPRODUCIBLE node build-stage.mjs --check
step ARCHIVE-TEST env -C "$H/tree" STAGE_TAR="$H/out/enclave-host-services-hs1.tar" node --test --test-concurrency=1 test/hosted-services-stage.test.mjs
echo "=== FAILED STEPS: $fails"
[ "$fails" -eq 0 ]
