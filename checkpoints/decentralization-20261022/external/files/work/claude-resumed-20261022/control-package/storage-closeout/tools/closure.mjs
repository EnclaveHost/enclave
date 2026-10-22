// The storage-indexer role's EXACT runtime import closure in the integrated source tree (work/enclave), resolved the way
// Node resolves it (platform node, ESM, conditions node+import), INCLUDING npm package files. Writes nothing but stdout.
import { build } from "/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules/esbuild/lib/main.js";
import path from "node:path";
const root = "/home/steven/Documents/Codex/2026-10-18/wo/work/enclave";
const entries = ["network/host-services/storage-indexer-host.mjs"];
const r = await build({ absWorkingDir: root, entryPoints: entries, bundle: true, write: false, platform: "node", format: "esm", target: "node20",
  metafile: true, logLevel: "silent", outdir: "/nonexistent-never-written", conditions: ["node", "import"] });
const files = Object.keys(r.metafile.inputs).sort();
for (const f of files) if (path.isAbsolute(f) || f.startsWith("../")) throw Error("escapes the tree: " + f);
console.log(JSON.stringify({ entries, files, warnings: r.warnings.map((w) => w.text) }, null, 1));
