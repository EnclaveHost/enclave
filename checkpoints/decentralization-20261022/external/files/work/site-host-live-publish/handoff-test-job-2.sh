#!/usr/bin/env bash
# Handoff tests + an OFFLINE smoke of the production entry point (pins, plan print, pin refusal, serving /state only;
# no /start, so no RPC, no wallet, no upload).
set -euo pipefail
cd "$(dirname "$0")"
node --test --test-concurrency=1 handoff/test/site-handoff.test.mjs
node handoff/serve-site-reserve.mjs --deployment-id 0x1abe9a34c07b5c9a2d0f85fd1873c1329d4fd92c3705b6c0e785ca282b970f2e --deposit-wei 1000000000000000 --print-only > logs/site-reserve-ops-2.json
node -e 'const a=require("./logs/site-reserve-ops-2.json");if(a.opsSha256!=="104cfff82613feca6972f82cbbaeb79f908ca82eee1b54d2703f84228c7d9ef5")throw Error("stage-B ops changed");console.log("stage-B ops", a.opsSha256)'
node handoff/serve-site-activation.mjs --print-plan > logs/handoff-plan.json 2> logs/handoff-plan.sha
PIN=$(sed -n 's/^plan sha256:\([0-9a-f]\{64\}\)$/\1/p' logs/handoff-plan.sha); test -n "$PIN"; echo "plan sha256:$PIN"
if node handoff/serve-site-activation.mjs --approved-plan sha256:0000000000000000000000000000000000000000000000000000000000000000 --serve 2> logs/smoke-refusal.txt; then echo "SERVED WITH A WRONG PIN"; exit 1; fi
grep -q "refusing to serve" logs/smoke-refusal.txt
node handoff/serve-site-activation.mjs --approved-plan "sha256:$PIN" --serve > logs/smoke-serve.json 2> logs/smoke-serve.err &
SRV=$!
for i in $(seq 1 60); do [ -s logs/smoke-serve.json ] && break; sleep 0.5; done
node -e '
const s=require("./logs/smoke-serve.json"); const u=new URL(s.url);
if(u.hostname!=="127.0.0.1"||u.port!=="39657")throw Error("not the loopback origin");
fetch(s.url+"/state").then(async r=>{const v=await r.json();
 if(r.headers.get("cache-control")!=="no-store")throw Error("cache");
 if(v.admin!=="0x0b2d009c0c9af05b12100d77f3c815fea822ee61"||v.chainId!=="0x2105"||v.session!=="not started"||v.next!=="upload")throw Error("state "+JSON.stringify(v).slice(0,200));
 if(v.steps.length!==3||v.stageB.steps.length!==2)throw Error("steps");
 const p=await fetch(s.url+"/start",{method:"POST",headers:{origin:s.url}});if(p.status!==403)throw Error("token-less POST was not refused");
 console.log("smoke: served", s.url, "plan", s.plan, "admin", v.admin, "next", v.next);});'
kill $SRV; wait $SRV 2>/dev/null || true
test ! -e handoff/journals-activation/session.json || ! grep -q started handoff/journals-activation/session.json
echo HANDOFF-TEST-JOB-2-OK
