#!/usr/bin/env bash
# Offline validation of the stage-B launcher: pins, reviewed builder, exact operations for the PREDICTED id (no RPC, no server).
set -euo pipefail
cd "$(dirname "$0")"
node handoff/serve-site-reserve.mjs --deployment-id 0x1abe9a34c07b5c9a2d0f85fd1873c1329d4fd92c3705b6c0e785ca282b970f2e --deposit-wei 1000000000000000 --print-only > logs/site-reserve-ops.json
# refusal paths: wrong approval pin, missing serve flag
if node handoff/serve-site-reserve.mjs --deployment-id 0x1abe9a34c07b5c9a2d0f85fd1873c1329d4fd92c3705b6c0e785ca282b970f2e --deposit-wei 1000000000000000 --approved-ops sha256:00 --serve 2>logs/refusal.txt; then echo "SERVED WITHOUT A VALID PIN"; exit 1; fi
grep -q "refusing to serve" logs/refusal.txt
if node handoff/serve-site-reserve.mjs --deployment-id 0x12 --deposit-wei 1 --print-only 2>/dev/null; then echo "ACCEPTED A BAD ID"; exit 1; fi
node -e '
const a=require("./logs/site-reserve-ops.json"), b=require("./logs/probe4.json").perProvider[0].operations;
const pick=o=>[o.kind,o.to,o.value,o.data,o.opId];
if(JSON.stringify(a.operations.map(pick))!==JSON.stringify(b.map(pick)))throw Error("print-only ops differ from the simulated ops");
console.log("ops", a.opsSha256, "match the probe4 simulation");'
echo PRINT-OPS-JOB-OK
