// Export superset: every name an OLD (recorded live) module exports is still exported by its replacement, so any old
// importer (CLI, the running manager's bytes, an old lazily-importing agent) still links. usage: node exports.mjs <old> <new> <rel>...
import { build } from "/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules/esbuild/lib/main.js";
import path from "node:path";
const [oldRoot, newRoot, ...rels] = process.argv.slice(2);
const exp = async (root, rel) => { const r = await build({ absWorkingDir: path.resolve(root), entryPoints: [rel], bundle: true, write: false, preserveSymlinks: true,
  platform: "node", format: "esm", target: "node20", packages: "external", logLevel: "silent", metafile: true, outdir: "/nonexistent-never-written" });
  return Object.values(r.metafile.outputs).find((o) => o.entryPoint)?.exports || []; };
const out = {}; let ok = true;
for (const rel of rels) { const o = await exp(oldRoot, rel), n = await exp(newRoot, rel); const lost = o.filter((x) => !n.includes(x));
  out[rel] = { oldExports: o.length, newExports: n.length, lost, added: n.filter((x) => !o.includes(x)) }; if (lost.length) ok = false; }
console.log(JSON.stringify(out, null, 1)); process.exit(ok ? 0 : 1);
