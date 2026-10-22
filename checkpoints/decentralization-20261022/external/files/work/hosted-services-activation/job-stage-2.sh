#!/bin/bash
# Run 2: the archive is unchanged since run 1 (only the test harness changed: async spawns so the rig's in-process RPC
# proxies keep answering). Re-prove the recorded archive is reproducible, then the archive test.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/hosted-services-activation
cd "$H"
fails=0
step() { local name=$1; shift; echo "=== STEP $name"; if "$@"; then echo "=== $name OK"; else echo "=== $name FAILED ($?)"; fails=$((fails+1)); fi; }
step REPRODUCIBLE node build-stage.mjs --check
step ARCHIVE-TEST env -C "$H/tree" STAGE_TAR="$H/out/enclave-host-services-hs1.tar" node --test --test-concurrency=1 test/hosted-services-stage.test.mjs
echo "=== FAILED STEPS: $fails"
[ "$fails" -eq 0 ]
