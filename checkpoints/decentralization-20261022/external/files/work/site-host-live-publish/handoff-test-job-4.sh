#!/usr/bin/env bash
# Handoff revalidation for the RECOVERY package (wasm 4044ea81…, upload CID bafybeia5kuad…, release bafybeic7sud3…):
# all handoff suites, the stage-B ops pin, the rebuilt plan and its new pin, a field-level diff against the reviewed plan
# (only the artifact fields may change), and the wrong-pin refusal. No wallet server is started (no --serve with the pin),
# no RPC, no upload; no journal may exist afterwards.
set -euo pipefail
cd "$(dirname "$0")"
node --test --test-concurrency=1 handoff/test/site-car.test.mjs handoff/test/site-handoff.test.mjs handoff/test/site-restart.test.mjs handoff/test/site-upload-net.test.mjs handoff/test/site-upload-secrets.test.mjs
node handoff/serve-site-reserve.mjs --deployment-id 0x1abe9a34c07b5c9a2d0f85fd1873c1329d4fd92c3705b6c0e785ca282b970f2e --deposit-wei 1000000000000000 --print-only > logs/site-reserve-ops-4.json
node -e 'const a=require("./logs/site-reserve-ops-4.json");if(a.opsSha256!=="104cfff82613feca6972f82cbbaeb79f908ca82eee1b54d2703f84228c7d9ef5")throw Error("stage-B ops changed");console.log("stage-B ops unchanged", a.opsSha256)'
node handoff/serve-site-activation.mjs --print-plan > logs/handoff-plan-4.json 2> logs/handoff-plan-4.sha
PIN=$(sed -n 's/^plan sha256:\([0-9a-f]\{64\}\)$/\1/p' logs/handoff-plan-4.sha); test -n "$PIN"; echo "NEW plan sha256:$PIN"
test "$PIN" = "$(sha256sum logs/handoff-plan-4.json | cut -c1-64)"
node - logs/handoff-plan.json logs/handoff-plan-4.json <<'JS'
const fs = require("fs"), [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const flat = (o, p = "", out = {}) => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) flat(v, p ? `${p}.${k}` : k, out); else out[p] = o; return out; };
const fa = flat(a), fb = flat(b), keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort(), changed = keys.filter((k) => fa[k] !== fb[k]);
const allowed = new Set(["wasm.sha256", "wasm.bytes", "expectedCid", "release", "steps.0.title", "steps.0.message", "steps.1.title", "steps.1.data"]);
const extra = changed.filter((k) => !allowed.has(k));
for (const k of changed) console.log(`changed ${k}: ${String(fa[k]).slice(0, 70)} -> ${String(fb[k]).slice(0, 70)}`);
if (extra.length) throw Error("the plan changed beyond the artifact fields: " + extra.join(", "));
for (const k of ["admin", "chainId", "appId", "predictedDeploymentId", "steps.1.to", "steps.2.to", "steps.2.data", "stageB.opsSha256", "stageB.depositWei", "totals.valueWei", "totals.usdc", "totals.walletConfirmations"])
  if (fa[k] !== fb[k]) throw Error(k + " changed");
console.log("PLAN-DELTA-OK: only the artifact fields changed; admin, contracts, deployment id, create, stage B, value, USDC and confirmations are unchanged");
JS
if node handoff/serve-site-activation.mjs --approved-plan sha256:bf02628af3e2efc83489e010cf6759c765f67bbc74a42e0740e2c1753c1b8038 --serve 2> logs/old-pin-refusal-4.txt; then echo "SERVED WITH THE OLD PIN"; exit 1; fi
grep -q "refusing to serve" logs/old-pin-refusal-4.txt && echo "the OLD reviewed pin is refused (the artifact changed)"
if node handoff/serve-site-activation.mjs --approved-plan sha256:0000000000000000000000000000000000000000000000000000000000000000 --serve 2> logs/smoke-refusal-4.txt; then echo "SERVED WITH A WRONG PIN"; exit 1; fi
grep -q "refusing to serve" logs/smoke-refusal-4.txt && echo "a wrong pin is refused"
test ! -e handoff/journals-activation && test ! -e handoff/journals && echo "no journals: every step not started"
echo HANDOFF-TEST-JOB-4-OK
