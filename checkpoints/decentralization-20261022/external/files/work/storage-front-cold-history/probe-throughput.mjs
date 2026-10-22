// Read-only: for the keyless endpoints that served OLD logs in probe-history.json, the largest accepted eth_getLogs range
// for the guest's actual query shape (the live ledger, topic0 in {Claimed, Renewed, Released}, topic1 = a deployment id)
// at ~35 days back, and the sustained rate: 40 sequential requests at that range, timed, errors counted. Output:
// logs/probe-throughput.json. No keys, no writes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENDPOINTS = ["https://base-mainnet.public.blastapi.io", "https://gateway.tenderly.co/public/base", "https://base.gateway.tenderly.co",
  "https://base-public.nodies.app", "https://mainnet.base.org"];
const LEDGER = "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b";
const TOPICS = [["0xa8cc21eb0ec0b0b7328426babbe37866c627edfd2ae57aeaed4f54abc0534bc0", "0xc3f167f2092d6942fb4264b1759de5eda7eedc20287375c9eddd62e98a560b3e",
  "0x0e334fd11ab7bea6d2bda89338c0f25674e099b70dd28aaaee262fbecba48882"], "0x" + "11".repeat(32)];
const hex = (n) => "0x" + n.toString(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getLogs(url, lo, hi) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 15000), t0 = Date.now();
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: c.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: LEDGER, topics: TOPICS, fromBlock: hex(lo), toBlock: hex(hi) }] }) });
    const text = await r.text(), ms = Date.now() - t0;
    let j; try { j = JSON.parse(text); } catch { return { ms, error: `HTTP ${r.status} ${text.slice(0, 100)}` }; }
    if (j.error) return { ms, error: `HTTP ${r.status} ${j.error.code}: ${String(j.error.message).slice(0, 160)}` };
    return Array.isArray(j.result) ? { ms, ok: true, count: j.result.length } : { ms, error: "no list" };
  } catch (e) { return { ms: Date.now() - t0, error: e.name === "AbortError" ? "timeout" : String(e.message).slice(0, 100) }; }
  finally { clearTimeout(t); }
}
const head = 52_860_000, base = head - 1_512_000;
const out = { at: new Date().toISOString(), base, endpoints: [] };
for (const url of ENDPOINTS) {
  const e = { url, ranges: {} };
  let best = 0;
  for (const span of [50, 100, 500, 1000, 2000, 5000, 10000]) {
    const r = await getLogs(url, base, base + span - 1); e.ranges[span] = r; if (r.ok) best = span; await sleep(1500);
  }
  e.bestRange = best;
  if (best) {
    const t0 = Date.now(); let ok = 0, errs = [];
    for (let i = 0; i < 40; i++) {
      const lo = base + 20_000 + i * best, r = await getLogs(url, lo, lo + best - 1);
      if (r.ok) ok++; else errs.push(r.error);
    }
    const sec = (Date.now() - t0) / 1000;
    e.sustained = { requests: 40, ok, seconds: sec, blocksPerSecond: Math.round((ok * best) / sec), errors: [...new Set(errs)].slice(0, 4) };
    e.thirtyDaysMinutes = e.sustained.blocksPerSecond ? +((1_296_000 / e.sustained.blocksPerSecond) / 60).toFixed(1) : null;
  }
  out.endpoints.push(e); console.log(JSON.stringify(e));
  await sleep(3000);
}
fs.writeFileSync(path.join(HERE, "logs/probe-throughput.json"), JSON.stringify(out, null, 1) + "\n");
console.log("WROTE logs/probe-throughput.json");
