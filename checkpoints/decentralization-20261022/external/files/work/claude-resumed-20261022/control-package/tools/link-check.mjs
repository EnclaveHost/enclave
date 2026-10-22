// esbuild link check (relative imports resolve AND every named import exists) of entries over a tree; npm packages
// external; writes nothing. usage: node link-check.mjs <root> <entry>...  -> JSON {entry: {ok, inputs | errors}}
import { build } from "/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules/esbuild/lib/main.js";
import path from "node:path";
const [root, ...entries] = process.argv.slice(2); const out = {};
for (const e of entries) {
  try {
    const r = await build({ absWorkingDir: path.resolve(root), entryPoints: [e], bundle: true, write: false, preserveSymlinks: true,
      platform: "node", format: "esm", target: "node20", packages: "external", logLevel: "silent", metafile: true, outdir: "/nonexistent-never-written" });
    out[e] = { ok: true, inputs: Object.keys(r.metafile.inputs).length, warnings: r.warnings.map((w) => w.text).slice(0, 5) };
  } catch (err) { out[e] = { ok: false, errors: (err.errors || [{ text: String(err.message) }]).map((x) => `${x.location?.file || ""}:${x.location?.line || ""} ${x.text}`).slice(0, 8) }; }
}
console.log(JSON.stringify(out, null, 1)); process.exit(Object.values(out).every((v) => v.ok) ? 0 : 1);
