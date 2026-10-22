// Read-only: is there a SECOND keyless operator (besides tenderly) that serves OLD Base logs fast enough for a cold start?
// Per candidate: TLS to the guest's measured roots, chain id, the largest accepted old-log range (~35 days back, the
// guest's query shape) and, if any, 30 sequential requests at it (blocks/s, errors). No keys, no writes.
// Output: logs/probe-operators.json.
import fs from "node:fs";
import tls from "node:tls";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = ["release/roots/isrg-root-x1.pem", "release/roots/isrg-root-x2.pem", "release/roots/sectigo-public-server-root-e46.pem",
  "release/roots/usertrust-ecc.pem", "bootstrap/roots/digicert-global-root-g2.pem", "bootstrap/roots/gts-root-r4.pem"]
  .map((f) => fs.readFileSync(path.join(HERE, "tree/isolation/m2", f), "utf8"));
// run 1 (logs/probe-operators.run1.log) covered ankr, notadegen, stackup and polkachu at 35 days; polkachu is retried
// inside its reported pruning window (earliest available block 51,500,000)
// run 2 (logs/probe-operators.run2.log) measured polkachu; run 3 the rest
const CANDIDATES = ["https://gateway.subquery.network/rpc/base-full", "https://base-mainnet.gateway.tatum.io",
  "https://base.rpc.blxrbdn.com", "https://base.callstaticrpc.com", "https://endpoints.omniatech.io/v1/base/mainnet/public",
  "https://base.llamarpc.com", "https://api.zan.top/base-mainnet", "https://base.api.onfinality.io/public", "https://mainnet.base.org"];
const LEDGER = "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b";
const TOPICS = [["0xa8cc21eb0ec0b0b7328426babbe37866c627edfd2ae57aeaed4f54abc0534bc0", "0xc3f167f2092d6942fb4264b1759de5eda7eedc20287375c9eddd62e98a560b3e",
  "0x0e334fd11ab7bea6d2bda89338c0f25674e099b70dd28aaaee262fbecba48882"], "0x" + "11".repeat(32)];
const hex = (n) => "0x" + n.toString(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(url, method, params) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 10000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: c.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = await r.text(); let j;
    try { j = JSON.parse(text); } catch { return { error: `HTTP ${r.status} ${text.slice(0, 80).replace(/\s+/g, " ")}` }; }
    if (j.error) return { error: `HTTP ${r.status} ${j.error.code}: ${String(j.error.message).slice(0, 120)}` };
    return { result: j.result };
  } catch (e) { return { error: e.name === "AbortError" ? "timeout" : String(e.cause?.code || e.message).slice(0, 80) }; }
  finally { clearTimeout(t); }
}
const measuredTls = (url) => new Promise((ok) => { const u = new URL(url);
  const s = tls.connect({ host: u.hostname, port: 443, servername: u.hostname, ca: ROOTS, timeout: 8000 }, () => { ok("ok"); s.end(); });
  s.on("error", (e) => ok("NO " + (e.code || e.message))); s.on("timeout", () => { ok("NO timeout"); s.destroy(); }); });
const head = 52_870_000, base = Number(process.env.PROBE_BASE || head - 1_200_000);   // ~28 days back
const out = { at: new Date().toISOString(), base, candidates: [] };
for (const url of CANDIDATES) {
  const e = { url, tls: await measuredTls(url) };
  const id = await rpc(url, "eth_chainId", []);
  e.chainId = id.error || (typeof id.result === "string" && /^0x[0-9a-f]+$/i.test(id.result) ? Number(BigInt(id.result)) : "bad chainId " + String(JSON.stringify(id.result)).slice(0, 60));
  if (e.chainId === 8453) {
    for (const span of [1000, 200, 50, 10]) {
      await sleep(1000);
      const r = await rpc(url, "eth_getLogs", [{ address: LEDGER, topics: TOPICS, fromBlock: hex(base), toBlock: hex(base + span - 1) }]);
      e[`old${span}`] = r.error || `ok(${r.result.length})`;
      if (!r.error) { e.bestRange = span; break; }
    }
    if (e.bestRange) {
      const t0 = Date.now(); let ok = 0; const errors = {};
      for (let i = 0; i < 30; i++) { const lo = base + 10_000 + i * e.bestRange;
        const r = await rpc(url, "eth_getLogs", [{ address: LEDGER, topics: TOPICS, fromBlock: hex(lo), toBlock: hex(lo + e.bestRange - 1) }]);
        if (r.error) errors[r.error] = (errors[r.error] || 0) + 1; else ok++; }
      const sec = (Date.now() - t0) / 1000;
      e.sustained = { requests: 30, ok, seconds: sec, blocksPerSecond: Math.round(ok * e.bestRange / sec), errors };
    }
  }
  out.candidates.push(e); console.log(JSON.stringify(e));
  await sleep(1500);
}
fs.writeFileSync(path.join(HERE, "logs/probe-operators.json"), JSON.stringify(out, null, 1) + "\n");
console.log("WROTE logs/probe-operators.json");
