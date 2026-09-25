// d1's independent check of a NucBox reference against v38's ba3f49a7, using 99's eligibleDigestsOf from main (7d3fa6fb).
import fs from "node:fs"; import { createHash } from "node:crypto";
import { eligibleDigestsOf } from "./nucbox-reference-main.mjs";
const [oldP, newP] = process.argv.slice(2);
const sha = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const oldR = JSON.parse(fs.readFileSync(oldP)), newR = JSON.parse(fs.readFileSync(newP));
const a = eligibleDigestsOf(oldR), b = eligibleDigestsOf(newR);
console.log(`old ${sha(oldP).slice(0,16)}: ${a.eligible.size} eligible ${[...a.eligible.keys()].map(k=>k.slice(0,8))}, ${a.refused.size} refused`);
console.log(`new ${sha(newP).slice(0,16)}: ${b.eligible.size} eligible ${[...b.eligible.keys()].map(k=>k.slice(0,8))}, ${b.refused.size} refused`);
const all = (x) => new Set([...x.eligible.keys(), ...x.refused.keys()]);
const A = all(a), B = all(b);
console.log(`digest set equal: ${A.size === B.size && [...A].every((k) => B.has(k))} (old ${A.size}, new ${B.size})`);
for (const k of B) if (!A.has(k)) console.log(`  NEW digest ${k.slice(0,16)}`);
for (const k of A) if (!B.has(k)) console.log(`  DROPPED digest ${k.slice(0,16)}`);
for (const [k, v] of b.refused) console.log(`  refused ${k.slice(0,8)} ${v.class} ${v.id}: ${String(v.reason).slice(0,90)}`);
for (const [k, v] of b.eligible) console.log(`  ELIGIBLE ${k} ${v.id} image ${v.imageSha256}`);
// every image field except eligible/reason/booted/class-of-superseded should be byte-identical for images carried over
const byId = (r) => new Map([...(r.images||[]), ...(r.superseded||[])].map((e) => [e.id, e]));
const O = byId(oldR), N = byId(newR);
for (const [id, n] of N) { const o = O.get(id); if (!o) { console.log(`  NEW entry ${id}`); continue; }
  const keys = new Set([...Object.keys(o), ...Object.keys(n)]);
  const diff = [...keys].filter((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k]));
  if (diff.length) console.log(`  changed ${id} (${O.has(id) && (oldR.images||[]).some(e=>e.id===id) ? "image" : "superseded"} -> ${(newR.images||[]).some(e=>e.id===id) ? "image" : "superseded"}): ${diff.join(", ")}`); }
for (const id of O.keys()) if (!N.has(id)) console.log(`  REMOVED entry ${id}`);
const topDiff = [...new Set([...Object.keys(oldR), ...Object.keys(newR)])].filter((k) => !["images","superseded"].includes(k) && JSON.stringify(oldR[k]) !== JSON.stringify(newR[k]));
console.log(`top-level fields changed: ${topDiff.join(", ") || "none"}`);
// mutation: any refused debug/probe/control/stock image marked eligible must be refused outright
let m = 0, ok = 0;
for (const img of newR.images || []) { if (img.eligible) continue; m++;
  const r = structuredClone(newR); for (const e of r.images) e.eligible = (e.id === img.id);
  try { eligibleDigestsOf(r); console.log(`  MUTATION NOT REFUSED: only ${img.id} eligible`); } catch (e) {
    if (img.class === "candidate" && !img.confidentialDebug && !img.trustsHostCommandLine) console.log(`  note: ${img.id} is a clean candidate`); ok++; } }
{ const r = structuredClone(newR); for (const e of r.images) if (!e.confidentialDebug && e.class === "candidate") e.eligible = true;
  const two = r.images.filter((e) => e.eligible).length; if (two < 2) console.log(`  two-eligible mutation: n/a (${two} clean candidate in images[]; the half-done-rollover case is tested separately)`); else try { eligibleDigestsOf(r); console.log(`  two-eligible mutation (${two}) NOT refused`); } catch { console.log(`  two-eligible mutation (${two} eligible): refused`); } }
console.log(`single-image eligible mutations on non-eligible images: ${ok}/${m} refused`);
let sm = 0, sok = 0;
for (const [i] of (newR.superseded || []).entries()) { sm++; const r = structuredClone(newR); r.superseded[i].eligible = true;
  try { eligibleDigestsOf(r); console.log(`  SUPERSEDED MUTATION NOT REFUSED: ${r.superseded[i].id}`); } catch { sok++; } }
console.log(`superseded entries marked eligible: ${sok}/${sm} refused`);
