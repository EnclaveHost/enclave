// READ-ONLY: this boot's risc-box turn history. Rejoins stderr fragments, finds the last boot (heartbeat
// `up=` going backwards), then classifies every SLOW TURN since it and lists the minutes that had one.
import fs from "node:fs";
const P = "C:\\Users\\claude\\vbs\\node\\enclave.log";
const st = fs.statSync(P), from = Math.max(0, st.size - 60e6);
const fd = fs.openSync(P, "r"), b = Buffer.alloc(st.size - from);
fs.readSync(fd, b, 0, b.length, from); fs.closeSync(fd);
const L = []; let cur = null;
for (const raw of b.toString("utf8").split(/\r?\n/)) {
  const m = raw.match(/^\[app\] stderr: ?(.*)$/);
  if (!m) { if (cur) { L.push(cur); cur = null; } continue; }
  if (m[1].startsWith("[")) { if (cur) L.push(cur); cur = m[1]; } else if (cur !== null) cur += m[1];
}
if (cur) L.push(cur);
let start = 0, lastUp = -1;
L.forEach((l, i) => { const u = l.match(/heartbeat: .*? up=(\d+)s/); if (u) { const up = +u[1]; if (up < lastUp) start = i; lastUp = up; } });
const B = L.slice(start);
const firstUp = (B.find((l) => /heartbeat/.test(l)) || "").match(/up=(\d+)s/);
console.log(`this boot: ${B.length} logical lines from heartbeat up=${firstUp ? firstUp[1] : "?"}s`);
// Walk in order; attribute slow turns to the minute (next heartbeat) they fall in.
let bucket = [], minutes = [];
for (const l of B) {
  const s = l.match(/SLOW TURN (\d+)ms: poll=(\d+) adm=(\d+) run=(\d+) collect=(\d+) flush=(\d+)/);
  if (s) bucket.push(s.slice(1).map(Number));
  const h = l.match(/heartbeat: .*? up=(\d+)s instret=([\d.]+)G .*?watchers=(\d+\/\d+).*?turn_max=(\d+)ms \[(.*?)\]/);
  if (h) { minutes.push({ up: +h[1], instret: +h[2], watchers: h[3], turnMax: +h[4], detail: h[5], slow: bucket }); bucket = []; }
}
const cls = (t) => (t[3] >= 200 ? "run>=200 (scan-sized)" : t[1] >= 200 ? "poll>=200 (status-sized)" : t[2] >= 200 ? "adm>=200" : "other");
const count = {}; for (const m of minutes) for (const t of m.slow) count[cls(t)] = (count[cls(t)] || 0) + 1;
console.log(`minutes ${minutes.length}; slow turns by class: ${JSON.stringify(count)}`);
const runs = minutes.flatMap((m) => m.slow.filter((t) => t[3] >= 200).map((t) => t[3])).sort((a, b) => a - b);
if (runs.length) console.log(`scan-sized run phase: n=${runs.length} p50=${runs[runs.length >> 1]} p90=${runs[Math.floor(runs.length * 0.9)]} max=${runs[runs.length - 1]} ms`);
// Guest progress per minute, split by whether the minute had scan-sized turns.
const rate = []; for (let i = 1; i < minutes.length; i++) {
  const a = minutes[i - 1], z = minutes[i], dt = z.up - a.up; if (dt <= 0) continue;
  rate.push({ up: z.up, mips: (z.instret - a.instret) * 1e3 / dt, scans: z.slow.filter((t) => t[3] >= 200).length, stats: z.slow.filter((t) => t[1] >= 200).length });
}
const avg = (xs) => (xs.length ? (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(3) : "-");
const withScan = rate.filter((r) => r.scans > 0).map((r) => r.mips), without = rate.filter((r) => r.scans === 0 && r.stats === 0).map((r) => r.mips);
console.log(`dispatched MIPS per minute: minutes WITH scan-sized turns avg ${avg(withScan)} (n=${withScan.length}); minutes with NO slow turns avg ${avg(without)} (n=${without.length})`);
console.log("--- minutes with the most slow turns ---");
for (const r of [...rate].sort((a, b) => (b.scans + b.stats) - (a.scans + a.stats)).slice(0, 8))
  console.log(`up=${r.up}s mips=${r.mips.toFixed(3)} scanTurns=${r.scans} statusTurns=${r.stats}`);
