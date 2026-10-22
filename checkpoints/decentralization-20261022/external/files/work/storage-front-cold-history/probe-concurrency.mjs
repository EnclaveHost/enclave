// Read-only: can the two operators that serve old Base logs keylessly (probe-throughput.json) sustain the scan a cold
// start needs? nodies.app: 60 requests of its 50-block maximum, 1 then 3 in flight. tenderly: 150 requests of 1000 blocks,
// 1 in flight. The guest's query shape (live ledger, lease topics, a deployment id). Output: logs/probe-concurrency.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b";
const TOPICS = [["0xa8cc21eb0ec0b0b7328426babbe37866c627edfd2ae57aeaed4f54abc0534bc0", "0xc3f167f2092d6942fb4264b1759de5eda7eedc20287375c9eddd62e98a560b3e",
  "0x0e334fd11ab7bea6d2bda89338c0f25674e099b70dd28aaaee262fbecba48882"], "0x" + "11".repeat(32)];
const hex = (n) => "0x" + n.toString(16);
async function getLogs(url, lo, hi) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: c.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: LEDGER, topics: TOPICS, fromBlock: hex(lo), toBlock: hex(hi) }] }) });
    const j = JSON.parse(await r.text());
    return j.error ? { error: `HTTP ${r.status} ${j.error.code}: ${String(j.error.message).slice(0, 80)}` } : { ok: Array.isArray(j.result) };
  } catch (e) { return { error: e.name === "AbortError" ? "timeout" : String(e.message).slice(0, 80) }; }
  finally { clearTimeout(t); }
}
async function run(url, span, n, inflight, start) {
  const t0 = Date.now(); let next = 0, ok = 0; const errors = {};
  await Promise.all(Array.from({ length: inflight }, async () => {
    while (next < n) { const i = next++; const lo = start + i * span; const r = await getLogs(url, lo, lo + span - 1);
      if (r.ok) ok++; else errors[r.error] = (errors[r.error] || 0) + 1; }
  }));
  const sec = (Date.now() - t0) / 1000;
  return { url, span, requests: n, inflight, ok, seconds: sec, blocksPerSecond: Math.round((ok * span) / sec), errors };
}
const base = 52_860_000 - 1_400_000;
const out = { at: new Date().toISOString(), runs: [] };
for (const [url, span, n, inflight, off] of [
  ["https://base-public.nodies.app", 50, 60, 1, 0], ["https://base-public.nodies.app", 50, 60, 3, 10_000],
  ["https://gateway.tenderly.co/public/base", 1000, 150, 1, 40_000]]) {
  const r = await run(url, span, n, inflight, base + off); out.runs.push(r); console.log(JSON.stringify(r));
  await new Promise((ok) => setTimeout(ok, 5000));
}
fs.writeFileSync(path.join(HERE, "logs/probe-concurrency.json"), JSON.stringify(out, null, 1) + "\n");
console.log("WROTE logs/probe-concurrency.json");
