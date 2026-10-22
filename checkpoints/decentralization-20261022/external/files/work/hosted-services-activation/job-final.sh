#!/bin/bash
# THE final refresh (once): fresh copy of current integrated main -> packages current -> hs2 archives with the PUBLIC
# APP_STATIC capture -> byte-identical rebuild -> APP_STATIC test + Linux archive test on the final archive. No contract
# bindings beyond the defaults; nothing is installed or activated.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/hosted-services-activation
cd "$H"
fails=0
step() { local name=$1; shift; echo "=== STEP $name"; if "$@"; then echo "=== $name OK"; else echo "=== $name FAILED ($?)"; fails=$((fails+1)); fi; }
step REFRESH-FINAL ./refresh-final.sh --app-static capture/app-static.json
if [ "$fails" -eq 0 ]; then
  step APP-STATIC-TEST env -C "$H/tree-final" node --test --test-concurrency=1 test/hosted-services-appstatic.test.mjs
  step ARCHIVE-TEST-FINAL env -C "$H/tree-final" STAGE_TAR="$H/out/enclave-host-services-hs2.tar" node --test --test-concurrency=1 test/hosted-services-stage.test.mjs
fi
echo "=== FAILED STEPS: $fails"
[ "$fails" -eq 0 ]
