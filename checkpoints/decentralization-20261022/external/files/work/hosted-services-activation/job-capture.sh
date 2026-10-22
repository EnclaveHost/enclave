#!/bin/bash
# PUBLIC-ONLY APP_STATIC capture (authorized: DNS queries to the four known fleet nameservers). The reviewed tool from the
# FINAL hs2 stage; no env extraction, no private config. Raw per-server answers are kept in the output (answers{}).
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/hosted-services-activation
S=$H/stage-r2/enclave-host-services-hs2
date -u +%FT%TZ
sha256sum "$S/bin/stage-tool.mjs" "$S/scripts/capture-app-static.sh"
NODE=/usr/bin/node bash "$S/scripts/capture-app-static.sh" > "$H/capture/app-static.json"
rc=$?
echo "capture exit $rc (0 = every label agreed; 3 = at least one refused - never resolved by choice)"
sha256sum "$H/capture/app-static.json"
cat "$H/capture/app-static.json"
exit 0
