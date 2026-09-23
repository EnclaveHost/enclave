// READ-ONLY: rejoin the app's stderr fragments in enclave.log and summarize risc-box turn timing.
// A logical line starts at a fragment beginning "[risc-box]"; following "[app] stderr:" fragments
// that don't start a new tagged line are appended to it.
import fs from "node:fs";
const P = "C:\\Users\\claude\\vbs\\node\\enclave.log";
const MB = Number(process.argv[2] || 40);
const st = fs.statSync(P), from = Math.max(0, st.size - MB * 1e6);
const fd = fs.openSync(P, "r"), b = Buffer.alloc(st.size - from);
fs.readSync(fd, b, 0, b.length, from); fs.closeSync(fd);
const logical = []; let cur = null;
for (const raw of b.toString("utf8").split(/\r?\n/)) {
  const m = raw.match(/^\[app\] stderr: ?(.*)$/);
  if (!m) { if (cur) { logical.push(cur); cur = null; } continue; }
  const frag = m[1];
  if (frag.startsWith("[")) { if (cur) logical.push(cur); cur = frag; }
  else if (cur !== null) cur += frag;
}
if (cur) logical.push(cur);
const hb = logical.filter((l) => l.startsWith("[risc-box] heartbeat"));
const slow = logical.filter((l) => l.startsWith("[risc-box] SLOW TURN"));
console.log(`logical lines ${logical.length}, heartbeats ${hb.length}, slow turns ${slow.length}`);
console.log("--- last 12 heartbeats ---");
for (const l of hb.slice(-12)) console.log(l.replace(/footprint=\d+MiB/, "").slice(0, 260));
// Phase breakdown of slow turns
const agg = { n: 0, poll: 0, adm: 0, run: 0, collect: 0, flush: 0, total: 0 }, dom = {};
const totals = [];
for (const l of slow) {
  const t = l.match(/SLOW TURN (\d+)ms: poll=(\d+) adm=(\d+) run=(\d+) collect=(\d+) flush=(\d+)/);
  if (!t) continue;
  const [tot, poll, adm, run, collect, flush] = t.slice(1).map(Number);
  agg.n++; agg.total += tot; agg.poll += poll; agg.adm += adm; agg.run += run; agg.collect += collect; agg.flush += flush;
  totals.push(tot);
  const d = Object.entries({ poll, adm, run, collect, flush }).sort((a, b) => b[1] - a[1])[0][0];
  dom[d] = (dom[d] || 0) + 1;
}
if (agg.n) {
  totals.sort((a, b) => a - b);
  const q = (p) => totals[Math.min(totals.length - 1, Math.floor(p * totals.length))];
  console.log(`--- ${agg.n} parsed slow turns: total p50=${q(0.5)} p90=${q(0.9)} max=${totals[totals.length - 1]} ms`);
  console.log(`mean ms per slow turn: poll=${(agg.poll / agg.n).toFixed(0)} adm=${(agg.adm / agg.n).toFixed(0)} run=${(agg.run / agg.n).toFixed(0)} collect=${(agg.collect / agg.n).toFixed(0)} flush=${(agg.flush / agg.n).toFixed(0)}`);
  console.log(`dominant phase: ${JSON.stringify(dom)}`);
  console.log("--- last 8 slow turns ---");
  for (const l of slow.slice(-8)) console.log(l.slice(0, 200));
}
