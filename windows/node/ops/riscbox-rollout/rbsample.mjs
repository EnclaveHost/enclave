// READ-ONLY sampler for the live risc-box: GET /status only, one request at a time, never
// concurrent (rb.mjs: this tenant wedges under parallel probing). Types nothing, restarts nothing.
// Usage: node rbsample.mjs <samples> <intervalSec>
import path from "node:path";
import { fetchSecrets } from "./secrets.mjs";
import { loadOperator } from "./chain.mjs";
const DIR = "C:\\Users\\claude\\vbs\\node";
const ID = "0xe64f7cba307e2d97485bde356d75564ccb74c5e31c272b5ab3349abfe122569b";
const BASE = "http://127.0.0.1:9822";
const acct = loadOperator(path.join(DIR, "operator.key"));
const sec = await fetchSecrets({ id: ID, endpoint: "https://api.enclave.host/t/nucbox-k11",
                                 sign: async (m) => acct.signMessage({ message: m }), log: () => {} });
const KEY = sec.env.RISCBOX_API_KEY;              // never printed
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const N = Number(process.argv[2] || 20), IV = Number(process.argv[3] || 15) * 1000;
const rows = [];
for (let i = 0; i < N; i++) {
  const t = performance.now();
  let s = null, ms = null, err = null;
  try {
    const res = await fetch(`${BASE}/status`, { headers: { "x-api-key": KEY }, signal: AbortSignal.timeout(60000) });
    const body = await res.text(); ms = performance.now() - t;
    s = JSON.parse(body);
  } catch (e) { err = String(e.message).split(KEY).join("<redacted>"); ms = performance.now() - t; }
  const r = { at: Date.now(), ms, s, err };
  rows.push(r);
  console.log(s ? `#${i} http=${ms.toFixed(0)}ms retired=${s.instret} steps=${s.steps} idle=${s.guestIdle} ` +
                  `turnMax=${s.turnMaxMs}ms[${s.turnMax}] capMs=${s.capMs} videoMs=${s.videoMs} fps=${s.fps} sentFps=${s.sentFps}`
                : `#${i} http=${ms.toFixed(0)}ms ERROR ${err}`);
  if (i < N - 1) await nap(Math.max(0, IV - (performance.now() - t)));
}
const ok = rows.filter((r) => r.s);
if (ok.length >= 2) {
  const a = ok[0], b = ok[ok.length - 1], dt = (b.at - a.at) / 1000;
  const dr = b.s.instret - a.s.instret, ds = b.s.steps - a.s.steps;
  const lat = ok.map((r) => r.ms).sort((x, y) => x - y);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(0);
  console.log(`SUMMARY over ${dt.toFixed(0)}s: retired ${(dr / 1e6 / dt).toFixed(3)} MIPS, dispatched ${(ds / 1e6 / dt).toFixed(3)} M/s, ` +
              `retired/dispatched ${(dr / ds).toFixed(3)}, idle samples ${ok.filter((r) => r.s.guestIdle).length}/${ok.length}, ` +
              `status latency p50=${q(0.5)} p90=${q(0.9)} max=${lat[lat.length - 1].toFixed(0)} ms`);
  // per-interval rates, to see whether it is steady
  const per = [];
  for (let i = 1; i < ok.length; i++) per.push(((ok[i].s.instret - ok[i - 1].s.instret) / 1e6 / ((ok[i].at - ok[i - 1].at) / 1000)).toFixed(3));
  console.log(`per-interval retired MIPS: ${per.join(" ")}`);
}
