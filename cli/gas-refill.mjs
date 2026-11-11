#!/usr/bin/env node
// cli/gas-refill.mjs - keep self-hosted apps' lease-gas reserves topped up from the owner's USDC, automatically.
//
//   node cli/gas-refill.mjs open   CONFIG [--port 42291]   the owner opens the refill session: a local page asks the owner's
//                                                          wallet for the grant and the USDC deposit (two signatures)
//   node cli/gas-refill.mjs run    CONFIG [--once]         every interval: reconcile, read reserves, refill at most one app
//   node cli/gas-refill.mjs status CONFIG                  the session, unresolved refills and every app's runway
//
// CONFIG (JSON): { "owner": "0x…", "deployments": ["0x…", …], "store": "/path/0700/dir",
//   "relayBase": "https://api.enclave.host", "rpcs": ["https://mainnet.base.org", …], "book": "0x…", "reserve": "0x…",
//   "terms": { REFILL_DEFAULTS overrides }, "policy": { "lowDays": 2, "targetDays": 7, "feeTier": 100, "intervalSec": 900 } }
//
// The owner's wallet signs only on the `open` page; this process never asks it for anything else. The session key it
// holds can spend only what the signed grant allows (sdk/funding-node/refill.mjs REFILL_LIMITS bound the terms offered).
import http from "node:http";
import fs from "node:fs";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPublicClient, fallback, http as viemHttp, recoverTypedDataAddress } from "viem";
import { base } from "viem/chains";
import { freshRecoveryScope, jsonRpc, relayClient, submitGasOpen, usdcDomain, depositTypedData, grantBody, verifyRuntime }
  from "../sdk/funding/funding-client.mjs";
import { newGasRecord } from "../sdk/funding/v2-store.mjs";
import { FileV2Store } from "../sdk/funding-node/node-store.mjs";
import { buildRefillGrant, refillNeed, refillOnce, refillTerms } from "../sdk/funding-node/refill.mjs";
import { executionBlockers } from "../sdk/funding/gas-execution.mjs";
import { randomHex32, sameAddr, lower } from "../sdk/funding/util.mjs";
import { quote as leaseQuote, RESERVE_ABI } from "../client/lease-executor-client.mjs";

// The deployed funding runtime, as the site pins it (selfhost-gas-topup.js FUNDING_RUNTIME_PINS); verifyRuntime re-proves
// every identity and code hash on chain before anything is used.
export const FUNDING_RUNTIME_PINS = Object.freeze({
  schema: "enclave-funding-browser-runtime-r1", chainId: 8453,
  factory: "0x83616b7fA62F8a43cfc634a25c0aCFb0CCAB76e8", implementation: "0x9a869B2BA0D6FB4F297Eb140406478f0aed55F96",
  gasAdapter: "0xE5198b7BA033612C45c720d204C469D9ECe77D9e", legacyFactory: "0x1F5c887c0cDF491b16AB6c449abAfDF9B2ec9C9C",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", feeTiers: [100, 500, 3000],
  codehashes: {
    factory: "0xcea778eb9622f6423e8a2159c83ae5b696e81e5f22e87e8c285516e663b87e0f",
    implementation: "0x94c41042068ffe6b08f43b6cb9546b4b725c81a60010a201fc0c428382cb3a95",
    gasAdapter: "0xe3cb6aeac87a81b82653f71327fb517a30b23285907ea47a4049cec5a432cf10",
  },
  source: { kind: "deployed-receipts", deployTxs: [
    "0x91da584b22366f81b1174d8b73571bd6a34ba54f721b8476b2e25fcf420ce6b6", "0xa394688c44c411a5129fd94fe590957214431fee1c95f54959ce5073c0407160",
    "0xc9ab30f239ceffac08344577b6238a4c16e65fcf36a59dde6c714abc098efc29", "0x9c0328c93b8c28c6c78a5bf94a9b7482aa5eca7034469a78634ff88ae60dbaad"],
    reviewedBy: "root: four deployed receipts verified; public live funding runtime pins verified 2026-10-29T01:57:05Z" },
});
const DEFAULTS = { relayBase: "https://api.enclave.host", rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  book: "0xab214342d5A490150A4A977063A2f88E21F80907", reserve: "0x12A3f873041Dec436DaA0085B766a399A6fA3639" };
const LEDGER_ABI = [{ type: "function", name: "leaseSec", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
    "id:bytes32", "owner:address", "appRef:string", "ports:string", "configCid:string", "gpuMilli:uint16", "cpuMilli:uint16", "appPort:uint32",
    "isPublic:bool", "active:bool", "createdAt:uint64", "rate:uint256", "balance6:uint256", "spent6:uint256", "runner:bytes32",
    "runnerOperator:address", "leaseUntil:uint64"].map((s) => { const [name, type] = s.split(":"); return { name, type }; }) }] }];

const nowS = () => BigInt(Math.floor(Date.now() / 1000));
const out = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

export function loadConfig(file) {
  const c = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  if (!/^0x[0-9a-fA-F]{40}$/.test(c.owner ?? "")) throw new Error("config.owner must be the owner's address");
  if (!Array.isArray(c.deployments) || !c.deployments.length) throw new Error("config.deployments must list deployment ids");
  if (!c.store) throw new Error("config.store must name a private directory");
  c.policy = { lowDays: 2, targetDays: 7, feeTier: 100, intervalSec: 900, ...(c.policy ?? {}) };
  refillTerms(c.terms ?? {});                  // range-checked up front
  return c;
}

async function context(c) {
  const rpc = jsonRpc(c.rpcs[0]);
  const relay = relayClient(c.relayBase);
  const runtime = await verifyRuntime({ pins: FUNDING_RUNTIME_PINS, rpc, relay, owner: c.owner, now: nowS() });
  const store = new FileV2Store(c.store);
  const client = createPublicClient({ chain: base, transport: fallback(c.rpcs.map((u) => viemHttp(u, { timeout: 15_000 }))) });
  const scopeOf = () => freshRecoveryScope({ rpc, book: c.book, owner: c.owner, legacyVault: runtime.cfg.legacyVault,
    deploymentIds: c.deployments, now: nowS() });
  return { c, rpc, relay, runtime, store, client, scopeOf };
}

/** The reserve facts refillNeed takes, for one deployment, from the chain (renew/claim priced at the current gas price). */
async function reserveFacts(ctx, id) {
  const { client, c } = ctx;
  const ledger = await client.readContract({ address: c.reserve, abi: RESERVE_ABI, functionName: "ledger" });
  const [d, leaseSec, gasPrice] = await Promise.all([client.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "get", args: [id] }),
    client.readContract({ address: ledger, abi: LEDGER_ABI, functionName: "leaseSec" }), client.getGasPrice()]);
  const r = await client.readContract({ address: c.reserve, abi: RESERVE_ABI, functionName: "reserveOf", args: [id, d.owner] });
  const [renewWei, claimWei] = await Promise.all(["renew", "claim"].map((kind) => leaseQuote({ client, reserve: c.reserve, kind, gasPrice })));
  return { balanceWei: r.balanceWei, renewWei, claimWei, leaseSec, leaseLive: BigInt(d.leaseUntil) > nowS() };
}

async function openRecord(store, owner) {
  const open = (await store.listKeys()).filter((r) => r.status === "open" && sameAddr(r.owner, owner) && r.grant?.preset === "gas-refill");
  if (open.length > 1) throw new Error(`${open.length} open refill sessions in ${store.dir}; keep one (end the others from the dashboard)`);
  return open[0] ?? null;
}

async function cmdRun(file, { once }) {
  for (;;) {
    let wait = 60;
    try {
      const c = loadConfig(file);
      wait = Number(c.policy.intervalSec);
      const ctx = await context(c);
      const left = ctx.runtime.intake ? Number(ctx.runtime.intake.notAfter) - Number(nowS()) : null;
      if (left !== null && left < 14 * 86_400) {
        out({ warn: `the relay's funding activation expires in ${Math.floor(left / 86_400)} days (notAfter ${ctx.runtime.intake.notAfter}); renew it on the control VM` });
      }
      if (!ctx.runtime.intake) { out({ action: "blocked", why: `the relay's gas.fund intake is off: ${ctx.runtime.intakeWhy}` }); }
      else {
        const record = await openRecord(ctx.store, c.owner);
        const r = await refillOnce({ runtime: ctx.runtime, store: ctx.store, record, relay: ctx.relay, relayBase: c.relayBase, rpc: ctx.rpc,
          subtle: webcrypto.subtle, scopeOf: ctx.scopeOf, reserveOf: (id) => reserveFacts(ctx, id), policy: c.policy, now: nowS, log: (m) => out({ log: m }) });
        out({ ...r, rows: r.rows?.map((x) => ({ id: x.id, due: x.due, runwayDays: x.runwayDays, skipped: x.skipped })) });
      }
    } catch (e) { out({ action: "error", code: e.code ?? null, why: e.message }); }
    if (once) return;
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

async function cmdStatus(file) {
  const c = loadConfig(file);
  const ctx = await context(c);
  const record = await openRecord(ctx.store, c.owner);
  const scope = await ctx.scopeOf();
  const cap = BigInt(record?.grant?.maxEthPerOp ?? refillTerms(c.terms ?? {}).maxEthPerOp);
  const apps = [];
  for (const [id, d] of scope.deployments) {
    const f = await reserveFacts(ctx, id);
    const n = refillNeed({ ...f, lowDays: c.policy.lowDays, targetDays: c.policy.targetDays, maxEthPerOp: cap });
    apps.push({ id, appId: d.appId, granted: !!record?.grant?.apps?.map(lower).includes(d.appId), balanceWei: f.balanceWei, runwayDays: n.runwayDays, due: n.due });
  }
  const view = record ? await ctx.relay("GET", `/funding/session/${ctx.runtime.cfg.vault}/${record.sid}`).catch((e) => ({ error: e.message })) : null;
  out({ intake: ctx.runtime.intake ? `on until ${new Date(Number(ctx.runtime.intake.notAfter) * 1000).toISOString()}` : `off: ${ctx.runtime.intakeWhy}`, vault: ctx.runtime.cfg.vault,
    session: record ? { sid: record.sid, expiresAt: record.grant.expiresAt, relay: view } : null,
    unresolved: record ? executionBlockers(await ctx.store.listJournal(), record).map((b) => ({ id: b.id, status: b.status })) : [], apps });
}

// ----- open: one local page, two owner signatures, then the relay's /funding/open and the on-chain proof -----

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Automatic gas refill</title><style>
:root{--bg:#f7f7f5;--fg:#1c1c1a;--muted:#6b6b66;--line:#dcdcd6;--act:#1d4ed8;--warn:#9a3412;--ok:#1f7a3f}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#a3a39c;--line:#33332f;--act:#93b4ff;--warn:#fdba74;--ok:#4ade80}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}.lead{color:var(--muted)}table{border-collapse:collapse;width:100%;font-size:13px;margin:12px 0}
td{border-top:1px solid var(--line);padding:4px 6px;vertical-align:top;word-break:break-all}td:first-child{color:var(--muted);width:38%;word-break:normal}
button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid var(--act);background:var(--act);color:#fff;cursor:pointer;margin-right:8px}
button:disabled{opacity:.45;cursor:not-allowed}#msg{margin-top:12px}.err{color:var(--warn)}.ok{color:var(--ok)}code{font:12px ui-monospace,monospace}
</style></head><body><main><h1>Turn on automatic gas refill</h1>
<p class="lead">Two signatures from your owner wallet on Base: the grant below, then a USDC deposit of the budget into your session vault. After that, the refiller tops up these apps' gas from that USDC on its own, within these limits. You can end the session from the Dashboard at any time; unspent USDC returns to you.</p>
<table id="terms"></table><button id="go">Connect and sign</button><div id="msg"></div></main>
<script type="module">
const $=(i)=>document.getElementById(i),esc=(s)=>String(s).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const r=await (await fetch("/review")).json();
$("terms").innerHTML=Object.entries(r.show).map(([k,v])=>"<tr><td>"+esc(k)+"</td><td><code>"+esc(v)+"</code></td></tr>").join("");
$("go").onclick=async()=>{const m=$("msg");$("go").disabled=true;m.className="";try{
 const p=window.ethereum;if(!p)throw new Error("no browser wallet");
 const [a]=await p.request({method:"eth_requestAccounts"});if(a.toLowerCase()!==r.owner.toLowerCase())throw new Error("connect the owner "+r.owner+", not "+a);
 if(parseInt(await p.request({method:"eth_chainId"}),16)!==8453)await p.request({method:"wallet_switchEthereumChain",params:[{chainId:"0x2105"}]});
 m.textContent="1 of 2: confirm the grant on the Trezor…";const ownerSig=await p.request({method:"eth_signTypedData_v4",params:[a,r.grantTyped]});
 m.textContent="2 of 2: confirm the USDC deposit on the Trezor…";const depSig=await p.request({method:"eth_signTypedData_v4",params:[a,r.depositTyped]});
 m.textContent="Submitting…";const s=await (await fetch("/signed",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ownerSig,depSig})})).json();
 if(s.error)throw new Error(s.error);m.className="ok";m.textContent=s.pending?"Sent ("+s.txHash+"); waiting for Base. The refiller starts once it is on chain.":"Open on chain: "+s.txHash+". You can close this page.";
}catch(e){m.className="err";m.textContent=(e&&e.code===4001)?"Rejected in the wallet. Nothing was sent.":"Not done: "+(e.message||e);$("go").disabled=false;}};
</script></body></html>`;

const typedJson = (td) => JSON.stringify({ types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...td.types }, domain: td.domain,
primaryType: td.primaryType, message: td.message }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

async function cmdOpen(file, { port }) {
  const c = loadConfig(file);
  const ctx = await context(c);
  const { runtime, store, relay, rpc } = ctx;
  if (!runtime.intake?.openEnabled) throw new Error(`the relay does not accept new sessions now: ${runtime.intakeWhy ?? "open disabled"}`);
  if (await openRecord(store, c.owner)) throw new Error("a refill session is already open in this store");
  const scope = await ctx.scopeOf();
  const now = nowS();
  const key = await store.newKey();
  const rec = newGasRecord({ key, chainId: 8453, relay: c.relayBase, owner: runtime.cfg.owner, vault: runtime.cfg.vault,
    factory: runtime.cfg.factory, implementation: runtime.cfg.implementation, label: "Automatic gas refill", now });
  const review = buildRefillGrant(runtime.cfg, { now, sessionKey: key.keyHash, appIds: scope.appIds, grantNonce: randomHex32(webcrypto),
    signBefore: now + 900n, terms: c.terms ?? {} });
  Object.assign(rec, { grant: grantBody(review), grantDigest: review.digest, sid: review.sessionId, status: "reviewed" });
  await store.saveKey(rec);
  const g = review.typedData.message;
  const dep = depositTypedData(await usdcDomain(rpc, runtime.pins.usdc), { from: runtime.cfg.owner, to: runtime.cfg.vault, value: g.budget,
    nonce: review.digest, validBefore: g.signBefore });
  const usd = (v) => `${(Number(v) / 1e6).toFixed(2)} USDC`;
  const show = { "Session vault": runtime.cfg.vault, "Apps (catalog ids)": g.apps.join(", "),
    "Deployments covered": [...scope.deployments.keys()].join(", "), "Deposit (budget)": usd(g.budget),
    "Spend per day at most": `${usd(g.spendPerPeriod)} in at most ${g.opsPerPeriod} refills`,
    "Per refill at most": `${(Number(g.maxEthPerOp) / 1e18).toFixed(6)} ETH, ${usd(g.maxGasUsdcPerOp)} swap input + ${usd(g.maxFeePerOp)} relay fee`,
    "Price cap": `${usd(g.maxUsdcPerEth6)} per ETH`, "Expires": new Date(Number(g.expiresAt) * 1000).toISOString(),
    "Sign before": new Date(Number(g.signBefore) * 1000).toISOString(), "Grant digest": review.digest };
  let done = false;
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(type === "application/json" ? JSON.stringify(body) : body); };
    try {
      if (req.method === "GET" && req.url === "/") return send(200, PAGE, "text/html; charset=utf-8");
      if (req.method === "GET" && req.url === "/review") return send(200, { owner: runtime.cfg.owner, show, grantTyped: typedJson(review.typedData), depositTyped: typedJson(dep) });
      if (req.method === "POST" && req.url === "/signed" && !done) {
        let body = ""; for await (const ch of req) { body += ch; if (body.length > 4096) throw new Error("too large"); }
        const { ownerSig, depSig } = JSON.parse(body);
        for (const [sig, td] of [[ownerSig, review.typedData], [depSig, dep]]) {
          if (!/^0x[0-9a-fA-F]{130}$/.test(String(sig))) throw new Error("not a 65-byte signature (contract wallets are not supported)");
          const who = await recoverTypedDataAddress({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message, signature: sig });
          if (!sameAddr(who, runtime.cfg.owner)) throw new Error("a signature does not recover to the owner");
        }
        if (nowS() > g.signBefore) throw new Error("the 15-minute signing window passed; run open again");
        done = true;
        const r = await submitGasOpen({ runtime, store, relay, rpc, record: rec, review, now: nowS(),
          body: { owner: runtime.cfg.owner, grant: grantBody(review), ownerSig, deposit: { validAfter: "0", validBefore: g.signBefore.toString(), sig: depSig } } });
        out({ action: "opened", ...r });
        send(200, r);
        setTimeout(() => server.close(), 1000);
        return;
      }
      send(404, { error: "not found" });
    } catch (e) { send(400, { error: String(e.message).slice(0, 300) }); }
  });
  server.listen(Number(port), "127.0.0.1", () => out({ action: "open_page", url: `http://127.0.0.1:${port}/`, signBefore: g.signBefore.toString() }));
  setTimeout(() => { if (!done) { out({ action: "open_expired", why: "the signing window passed unused; nothing was sent" }); server.close(); } }, 905_000);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, file, ...rest] = process.argv.slice(2);
  const flag = (n, d) => { const i = rest.indexOf(n); return i < 0 ? d : (rest[i + 1] ?? true); };
  const run = { open: () => cmdOpen(file, { port: flag("--port", "42291") }), run: () => cmdRun(file, { once: rest.includes("--once") }),
    status: () => cmdStatus(file) }[cmd];
  if (!run || !file) { console.error("usage: node cli/gas-refill.mjs open|run|status CONFIG [--port N] [--once]"); process.exit(2); }
  run().catch((e) => { out({ action: "error", code: e.code ?? null, why: e.message }); process.exit(1); });
}
