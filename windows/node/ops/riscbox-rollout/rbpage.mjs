// VERIFY - what a user with the page OPEN gets. Reproduces the page's own load exactly as index.html
// generates it (one /fb.bands long-poll at a time, /status every 1.5 s, a /console stream) and
// measures: desktop update cadence, band bytes, /status stall, retired MIPS, turn phases. With an
// instance name it also runs keylat.mjs on THAT instance (a fork: never types into main's console).
// Usage: node rbpage.mjs <seconds> [instance-for-keylat]
import path from "node:path";
import { spawn } from "node:child_process";
import { fetchSecrets } from "./secrets.mjs";
import { loadOperator } from "./chain.mjs";
const DIR = "C:\\Users\\claude\\vbs\\node", ID = "0xe64f7cba307e2d97485bde356d75564ccb74c5e31c272b5ab3349abfe122569b";
const B = "http://127.0.0.1:9822";
const acct = loadOperator(path.join(DIR, "operator.key"));
const sec = await fetchSecrets({ id: ID, endpoint: "https://api.enclave.host/t/nucbox-k11",
                                 sign: async (m) => acct.signMessage({ message: m }), log: () => {} });
const KEY = sec.env.RISCBOX_API_KEY;              // never printed
const H = { "x-api-key": KEY };
const SECS = Number(process.argv[2] || 120), INST = process.argv[3] || "";
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const end = Date.now() + SECS * 1000;
const ac = new AbortController();
// the page's console stream (cheap, but it is part of what the page holds open)
(async () => { try { const r = await fetch(`${B}/console?key=${encodeURIComponent(KEY)}`, { signal: ac.signal }); for await (const _ of r.body) {} } catch {} })();
// the page's picture: one parked long-poll at a time
const pulls = [];
const pull = (async () => {
  let gen = 0;
  while (Date.now() < end) {
    const t = Date.now();
    try {
      const r = await fetch(`${B}/fb.bands?since=${gen}&wait=1`, { headers: H, signal: AbortSignal.timeout(60000) });
      const txt = await r.text(); const j = JSON.parse(txt);
      gen = j.gen;
      pulls.push({ at: Date.now(), ms: Date.now() - t, n: j.events.length, bytes: txt.length, resync: j.resync });
    } catch (e) { pulls.push({ at: Date.now(), ms: Date.now() - t, err: String(e.message).split(KEY).join("<redacted>") }); await nap(300); }
  }
})();
// the page's status refresh
const stats = [];
const status = (async () => {
  while (Date.now() < end) {
    const t = Date.now();
    try { const s = JSON.parse(await (await fetch(`${B}/status`, { headers: H, signal: AbortSignal.timeout(60000) })).text());
          stats.push({ at: Date.now(), ms: Date.now() - t, instret: s.instret, turnMax: `${s.turnMaxMs}ms[${s.turnMax}]`, capMs: s.capMs, fps: s.fps }); }
    catch (e) { stats.push({ at: Date.now(), ms: Date.now() - t, err: true }); }
    await nap(Math.max(0, 1500 - (Date.now() - t)));
  }
})();
let keylat = "";
if (INST) {
  await nap(10000);
  keylat = await new Promise((res) => { let o = ""; const p = spawn("node", [path.join(DIR, "keylat.mjs"), "local", INST]);
    p.stdout.on("data", (d) => o += d); p.stderr.on("data", (d) => o += d); p.on("close", () => res(o.split(KEY).join("<redacted>"))); });
}
await Promise.all([pull, status]); ac.abort();
const q = (a, p) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(0) : "-";
const moved = pulls.filter((p) => p.n > 0), gaps = moved.slice(1).map((p, i) => p.at - moved[i].at);
const sOk = stats.filter((s) => !s.err);
const secs = (pulls.at(-1)?.at - pulls[0]?.at) / 1000 || SECS;
console.log(`PAGE ${SECS}s: desktop updates ${moved.length} (${(moved.length / secs).toFixed(2)}/s), gap between updates p50=${q(gaps, 0.5)} p90=${q(gaps, 0.9)} ms, band bytes ${(moved.reduce((s, p) => s + p.bytes, 0) / secs / 1024).toFixed(1)} KiB/s, pull errors ${pulls.filter((p) => p.err).length}`);
console.log(`PAGE /status n=${sOk.length} latency p50=${q(sOk.map((s) => s.ms), 0.5)} p90=${q(sOk.map((s) => s.ms), 0.9)} max=${q(sOk.map((s) => s.ms), 1)} ms`);
if (sOk.length >= 2) { const a = sOk[0], z = sOk.at(-1); console.log(`PAGE retired ${((z.instret - a.instret) / 1e6 / ((z.at - a.at) / 1000)).toFixed(3)} MIPS while the page was open; capMs last ${z.capMs}; fps last ${z.fps}`); }
console.log(`PAGE turnMax seen: ${[...new Set(sOk.map((s) => s.turnMax))].slice(-6).join(" | ")}`);
if (keylat) console.log(`KEYLAT on instance ${INST} (page load running):\n${keylat.trim()}`);
