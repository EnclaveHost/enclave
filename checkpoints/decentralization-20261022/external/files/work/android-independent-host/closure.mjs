// The relative-import closure of the deployed Android agent (runner/*.mjs, standalone entry, tests' imports) in the DEPLOYED
// tree, classified against main: missing-in-main / differs / same. Read-only on both trees.
import fs from "node:fs"; import path from "node:path"; import { createHash } from "node:crypto";
const DEP = process.argv[2], MAIN = process.argv[3], roots = process.argv.slice(4);
const h = (f) => { try { return createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } catch { return null; } };
const seen = new Set(), out = [];
const RE = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^import\s*["']([^"']+)["']/gm;
function walk(rel) {
  if (seen.has(rel)) return; seen.add(rel);
  const abs = path.join(DEP, rel); if (!fs.existsSync(abs)) { out.push({ rel, kind: "missing-in-deployed" }); return; }
  const m = h(path.join(MAIN, rel)), d = h(abs);
  out.push({ rel, kind: m === null ? "missing-in-main" : m === d ? "same" : "differs" });
  if (!/\.(m?js|cjs)$/.test(rel)) return;
  const src = fs.readFileSync(abs, "utf8"); let x;
  while ((x = RE.exec(src))) { const s = x[1] || x[2] || x[3]; if (!s || !s.startsWith(".")) continue; walk(path.normalize(path.join(path.dirname(rel), s))); }
}
for (const r of roots) walk(r);
console.log(JSON.stringify(out.sort((a, b) => a.kind.localeCompare(b.kind) || a.rel.localeCompare(b.rel)), null, 0).replace(/\},\{/g, "},\n{"));
