#!/usr/bin/env node
// custody-canary-proof catalog publication: READ-ONLY preparation for root. Never reads a key, signs, uploads or sends.
//   --print     offline: the exact call (selector, args, calldata, sha256, expected catalog appId). No network.
//   --prepare   live, read-only: two RPCs at one agreed block. The read path is fixed at 54 JSON-RPC requests; with
//               per-provider pacing (one start per 250 ms each) and bounded HTTP-429-only retries (<= 3 per request,
//               Retry-After <= 5 s honoured, else 0.5/1/2 s) it never exceeds 80 attempts or 60 s, and the agreed block is
//               at most 60 s old when the plan is written (lib PACING). Writes prepared/<planHash>.json (public) and
//               prints the plan hash. Exit 3 on a refusal (with its code: rpc_rate_limited, rpc_budget, stale, ...).
import fs from "node:fs";
import path from "node:path";
import { createPreparer, request, PRODUCTION, COMPONENT, SELECTOR, Refusal, httpRpc, PACING } from "../lib/publish.mjs";

const mode = process.argv[2];
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
if (mode === "--print") {
  const r = request();
  console.log(JSON.stringify({ chainId: PRODUCTION.chainId, from: PRODUCTION.publisher, to: PRODUCTION.catalog, value: "0", selector: SELECTOR,
    function: "publishVersion(string,string,string,string,string,uint32[4],string,string,uint256)", args: r.args, data: r.data,
    dataSha256: r.dataSha256, expectedCatalogAppId: r.appId, component: COMPONENT }, big, 1));
} else if (mode === "--prepare") {
  const counter = { n: 0 };
  const preparer = createPreparer({ rpc: httpRpc(15_000, counter), pacing: PACING });
  try {
    const out = await preparer.prepare();
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "prepared");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${out.planHash}.json`), out.text, { flag: "wx", mode: 0o644 });
    console.log(JSON.stringify({ status: out.status, planHash: out.planHash, requests: counter.n, transport: out.plan.transport, fees: out.plan.observed.fees,
      balanceSufficient: out.plan.observed.balanceSufficient }, null, 1));
  } catch (e) {
    const st = preparer.stats();
    const tail = `(${counter.n} requests, ${st?.retries429 ?? 0} 429 retries)`;
    if (e instanceof Refusal) { console.error(`REFUSED ${e.code}: ${e.message} ${tail}`); process.exit(3); }
    console.error(`FAILED (not retried): ${e.message} ${tail}`); process.exit(1);
  }
} else {
  console.error("usage: publish-prepare.mjs --print | --prepare");
  process.exit(2);
}
