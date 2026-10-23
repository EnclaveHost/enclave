// The dashboard's module graph bundled exactly as scripts/build-site.mjs bundles it (esbuild, js/boot.js entry, splitting,
// /vendor/* and https://* external), WITHOUT its template-inlining plugin, tailwind or contract artifacts: proves the new
// module resolves and lands in the bundle. Output in ../tmp/esb (not the tree).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const REPO = path.resolve(process.argv[2]), OUT = path.resolve(process.argv[3]);
const { build, stop } = createRequire(path.join(REPO, "package.json"))("esbuild");   // the tree's own esbuild
fs.rmSync(OUT, { recursive: true, force: true });
const r = await build({ entryPoints: [path.join(REPO, "site/js/boot.js")], bundle: true, splitting: true, format: "esm", target: ["es2022"], minify: true,
  outdir: OUT, outbase: path.join(REPO, "site"), chunkNames: "js/chunks/[name]-[hash]", external: ["https://*", "/vendor/*"], metafile: true, logLevel: "warning" });
const inputs = Object.keys(r.metafile.inputs);
console.log("inputs", inputs.length, "profile-broadcast in graph:", inputs.some((i) => i.endsWith("site/js/core/profile-broadcast.js")));
const files = []; const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : files.push(p); } }; walk(OUT);
for (const s of ["eth_signTransaction", "eth_sendRawTransaction", "every endpoint of the network profile refused", "does not sign a transaction without broadcasting", "Enclave runs part of this account"])
  console.log("chunks containing [" + s + "]:", files.filter((f) => f.endsWith(".js") && fs.readFileSync(f, "utf8").includes(s)).length);
stop();
