// READ-ONLY: alternate GET /ping and GET /status, strictly one at a time, to split a status call's
// cost into "waiting for the loop" (what /ping pays) and "building the status body" (the rest).
import path from "node:path";
import { fetchSecrets } from "./secrets.mjs";
import { loadOperator } from "./chain.mjs";
const DIR = "C:\\Users\\claude\\vbs\\node", ID = "0xe64f7cba307e2d97485bde356d75564ccb74c5e31c272b5ab3349abfe122569b";
const acct = loadOperator(path.join(DIR, "operator.key"));
const sec = await fetchSecrets({ id: ID, endpoint: "https://api.enclave.host/t/nucbox-k11",
                                 sign: async (m) => acct.signMessage({ message: m }), log: () => {} });
const KEY = sec.env.RISCBOX_API_KEY;              // never printed
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
async function hit(route) {
  const t = performance.now();
  const res = await fetch(`http://127.0.0.1:9822${route}`, { headers: { "x-api-key": KEY }, signal: AbortSignal.timeout(60000) });
  const body = await res.text();
  return { ms: performance.now() - t, status: res.status, body };
}
const ping = [], stat = [];
let turnDetail = [];
for (let i = 0; i < 12; i++) {
  ping.push((await hit("/ping")).ms); await nap(4000);
  const s = await hit("/status"); stat.push(s.ms);
  try { const j = JSON.parse(s.body); turnDetail.push(j.turnMax); } catch {}
  await nap(4000);
}
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(0);
console.log(`/ping   n=${ping.length} p50=${q(ping, 0.5)} p90=${q(ping, 0.9)} max=${Math.max(...ping).toFixed(0)} ms`);
console.log(`/status n=${stat.length} p50=${q(stat, 0.5)} p90=${q(stat, 0.9)} max=${Math.max(...stat).toFixed(0)} ms`);
console.log(`turnMax seen by /status: ${[...new Set(turnDetail)].join(" | ")}`);
