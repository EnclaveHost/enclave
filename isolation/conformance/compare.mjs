// compare.mjs: compare two conformance records and print PASS/FAIL lines.
//   node isolation/conformance/compare.mjs <linux-record.json> <windows-record.json> [--out report.json]
import fs from "node:fs";
import { compare, RECORD_VERSION } from "./record.mjs";

const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) { console.error("usage: compare.mjs <a.json> <b.json> [--out report.json]"); process.exit(2); }
const a = JSON.parse(fs.readFileSync(fa, "utf8")), b = JSON.parse(fs.readFileSync(fb, "utf8"));
for (const [n, r] of [[fa, a], [fb, b]]) if (r.version !== RECORD_VERSION) { console.error(`${n}: record version ${r.version}, expected ${RECORD_VERSION}`); process.exit(2); }
const res = compare(a, b);
console.log(`conformance: ${a.platform} (${a.tier}, image ${String(a.image.sha256).slice(0, 12)}) vs ${b.platform} (${b.tier}, image ${String(b.image.sha256).slice(0, 12)})`);
console.log(`  [${a.image.sha256 && a.image.sha256 === b.image.sha256 ? "PASS" : "FAIL"}] the same guest image on both (sha256)`);
for (const f of res.findings) console.log(`  [FAIL] ${f.path}: ${JSON.stringify(f.a)} vs ${JSON.stringify(f.b)}  -- ${f.why}`);
console.log(`  [${res.ok ? "PASS" : "FAIL"}] ${res.checked} must-match fields agree${res.ok ? "" : ` (${res.findings.length} findings)`}`);
console.log("  platform differences, stated:");
for (const d of res.differences) console.log(`    ${d.path}: ${JSON.stringify(d.a)} vs ${JSON.stringify(d.b)}  -- ${d.why}`);
console.log("  timings (not compared):");
for (const [n, r] of [["a", a], ["b", b]]) console.log(`    ${r.platform}: ${JSON.stringify(r.timings)}`);
const out = process.argv.indexOf("--out");
if (out > 0) fs.writeFileSync(process.argv[out + 1], JSON.stringify({ a: fa, b: fb, ...res, imageSame: a.image.sha256 === b.image.sha256 }, null, 1));
process.exit(res.ok && a.image.sha256 === b.image.sha256 ? 0 : 1);
