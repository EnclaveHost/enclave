// Read-only probe of KEYLESS public Base RPC endpoints for what a cold-starting guest needs: old eth_getLogs (35 and 120
// days back), the range each accepts, old block headers, and whether its TLS chains to the guest's MEASURED roots only
// (isolation/m2/release/roots + bootstrap/roots). No keys, no signup, no writes: eth_chainId, eth_blockNumber,
// eth_getBlockByNumber, eth_getLogs. A few requests per endpoint, spaced. Output: logs/probe-history.json.
import fs from "node:fs";
import tls from "node:tls";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = ["release/roots/isrg-root-x1.pem", "release/roots/isrg-root-x2.pem", "release/roots/sectigo-public-server-root-e46.pem",
  "release/roots/usertrust-ecc.pem", "bootstrap/roots/digicert-global-root-g2.pem", "bootstrap/roots/gts-root-r4.pem"]
  .map((f) => fs.readFileSync(path.join(HERE, "tree/isolation/m2", f), "utf8"));
const ENDPOINTS = [
  "https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://base.llamarpc.com",
  "https://1rpc.io/base", "https://base.meowrpc.com", "https://base-mainnet.public.blastapi.io", "https://base.gateway.tenderly.co",
  "https://gateway.tenderly.co/public/base", "https://base.blockpi.network/v1/rpc/public", "https://endpoints.omniatech.io/v1/base/mainnet/public",
  "https://base-pokt.nodies.app", "https://base-public.nodies.app", "https://base.api.onfinality.io/public", "https://developer-access-mainnet.base.org",
  "https://base.rpc.subquery.network/public", "https://api.zan.top/base-mainnet", "https://base.lava.build", "https://rpc.therpc.io/base",
];
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const REGISTRY = "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac";
const LEDGER = "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => "0x" + n.toString(16);
async function rpc(url, method, params) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 10000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: c.signal });
    const text = await r.text();
    if (r.status !== 200) return { error: `HTTP ${r.status}: ${text.slice(0, 120)}` };
    let j; try { j = JSON.parse(text); } catch { return { error: "not JSON: " + text.slice(0, 80) }; }
    if (j.error) return { error: `${j.error.code}: ${String(j.error.message).slice(0, 140)}` };
    return { result: j.result };
  } catch (e) { return { error: String(e.name === "AbortError" ? "timeout" : e.message).slice(0, 120) }; }
  finally { clearTimeout(t); }
}
function measuredTls(url) {
  const u = new URL(url);
  return new Promise((ok) => {
    const s = tls.connect({ host: u.hostname, port: 443, servername: u.hostname, ca: ROOTS, rejectUnauthorized: true, timeout: 8000 }, () => {
      let c = s.getPeerCertificate(true), top = c; while (top.issuerCertificate && top.issuerCertificate !== top) top = top.issuerCertificate;
      ok({ ok: true, root: top.subject?.CN || top.subject?.O }); s.end();
    });
    s.on("error", (e) => ok({ ok: false, error: e.code || e.message }));
    s.on("timeout", () => { ok({ ok: false, error: "timeout" }); s.destroy(); });
  });
}
const digest = (logs) => createHash("sha256").update(JSON.stringify(logs.map((l) => [l.blockNumber, l.logIndex, l.transactionHash, l.blockHash]))).digest("hex").slice(0, 16);
async function logs(url, address, topics, lo, hi) {
  const r = await rpc(url, "eth_getLogs", [{ address, topics, fromBlock: hex(lo), toBlock: hex(hi) }]);
  if (r.error) return { range: hi - lo + 1, error: r.error };
  if (!Array.isArray(r.result)) return { range: hi - lo + 1, error: "not a list" };
  return { range: hi - lo + 1, count: r.result.length, digest: digest(r.result) };
}

const out = { at: new Date().toISOString(), note: "35d/120d = blocks head-1,512,000 / head-5,184,000 (2 s blocks)", endpoints: [] };
const ref = await rpc("https://mainnet.base.org", "eth_blockNumber", []);
const head = Number(BigInt(ref.result)) - 1000;                 // a fixed point all endpoints have
const d35 = head - 1_512_000, d120 = head - 5_184_000;
out.head = head; out.d35 = d35; out.d120 = d120;
for (const url of ENDPOINTS) {
  const e = { url };
  e.tls = await measuredTls(url);
  const id = await rpc(url, "eth_chainId", []); e.chainId = id.error ? id.error : Number(BigInt(id.result));
  if (e.chainId !== 8453) { out.endpoints.push(e); continue; }
  await sleep(300);
  const hd = await rpc(url, "eth_getBlockByNumber", [hex(d120), false]); e.header120d = hd.error ? { error: hd.error } : { hash: hd.result?.hash };
  await sleep(300);
  e.usdc10_35d = await logs(url, USDC, [TRANSFER], d35, d35 + 9); await sleep(300);
  e.usdc10_120d = await logs(url, USDC, [TRANSFER], d120, d120 + 9); await sleep(300);
  // sparse contract (the schema-4 registry): which ranges are accepted at all
  for (const span of [1000, 2000, 10000, 50000]) { e[`registry${span}_35d`] = await logs(url, REGISTRY, [], d35, d35 + span - 1); await sleep(300); }
  // the live ledger's whole life (first block with code 52,515,705), in one request if accepted
  e.ledgerLife = await logs(url, LEDGER, [], 52_515_705, Math.min(head, 52_515_705 + 9999)); await sleep(300);
  out.endpoints.push(e);
  console.log(JSON.stringify(e));
}
fs.writeFileSync(path.join(HERE, "logs/probe-history.json"), JSON.stringify(out, null, 1) + "\n");
console.log("WROTE logs/probe-history.json");
