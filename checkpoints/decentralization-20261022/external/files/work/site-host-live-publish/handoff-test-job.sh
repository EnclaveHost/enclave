#!/usr/bin/env bash
# Site-activation handoff tests (in-memory model, injected wallet and gateway; no network) + the stage-B CLI print check.
set -euo pipefail
cd "$(dirname "$0")"
node --test --test-concurrency=1 handoff/test/site-handoff.test.mjs
node handoff/serve-site-reserve.mjs --deployment-id 0x1abe9a34c07b5c9a2d0f85fd1873c1329d4fd92c3705b6c0e785ca282b970f2e --deposit-wei 1000000000000000 --print-only > logs/site-reserve-ops-2.json
node -e 'const a=require("./logs/site-reserve-ops-2.json");if(a.opsSha256!=="104cfff82613feca6972f82cbbaeb79f908ca82eee1b54d2703f84228c7d9ef5")throw Error("stage-B ops changed");console.log("stage-B ops", a.opsSha256)'
echo HANDOFF-TEST-JOB-OK
