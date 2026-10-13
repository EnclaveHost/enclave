#!/usr/bin/env node
// verifier/web/build.mjs: the browser verifier bundle, packaged reproducibly.
//   node verifier/web/build.mjs                 -> verifier/web/dist/{enclave-verifier-web.js, MANIFEST.json, THIRD-PARTY-NOTICES.md}
//   node verifier/web/build.mjs --out FILE      -> one ad-hoc bundle, nothing else written
// The manifest records the artifact's sha256, the build tool and options, and EVERY input esbuild bundled with its own sha256,
// so the artifact's provenance is explicit down to the file: verifier/web/reproduce.mjs rebuilds from the tree and refuses
// on any difference in the artifact, an input, or the notices. Same-origin delivery is the site's (scripts/build-vendor.mjs)
// and is not done here; nothing references this artifact yet.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build, version as esbuildVersion } from "esbuild";
import { noticesFor } from "./notices.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "..", "..");
export const DIST = path.join(HERE, "dist"), ARTIFACT = "enclave-verifier-web.js", MANIFEST = "MANIFEST.json", NOTICES = "THIRD-PARTY-NOTICES.md";
export const OPTIONS = Object.freeze({ entry: "verifier/web/index.mjs", format: "esm", platform: "browser", target: "es2022", minify: true,
  alias: { "node:crypto": "verifier/web/shims/node-crypto.mjs", "node:zlib": "verifier/web/shims/node-zlib.mjs" }, inject: ["verifier/web/shims/buffer-global.mjs"] });
const sha = (b) => createHash("sha256").update(b).digest("hex");

export async function buildWeb({ outfile = path.join(DIST, ARTIFACT), minify = OPTIONS.minify } = {}) {
  const r = await build({
    entryPoints: [path.join(REPO, OPTIONS.entry)], outfile, bundle: true, format: OPTIONS.format, platform: OPTIONS.platform, target: [OPTIONS.target], minify,
    absWorkingDir: REPO, logLevel: "warning", metafile: true,
    alias: Object.fromEntries(Object.entries(OPTIONS.alias).map(([k, v]) => [k, path.join(REPO, v)])), inject: OPTIONS.inject.map((p) => path.join(REPO, p)),
  });
  const out = fs.readFileSync(outfile);
  const inputs = Object.keys(r.metafile.inputs).sort().map((p) => ({ path: p, bytes: r.metafile.inputs[p].bytes, sha256: sha(fs.readFileSync(path.join(REPO, p))) }));
  return { outfile, bytes: out.length, sha256: sha(out), inputs, esbuild: esbuildVersion };
}
export const manifestFor = (b) => ({ artifact: { file: ARTIFACT, bytes: b.bytes, sha256: b.sha256 }, build: { tool: "esbuild", version: b.esbuild, ...OPTIONS }, inputs: b.inputs });
export const noticesOf = (b) => noticesFor(b.inputs.map((i) => i.path), { repo: REPO, tool: `esbuild ${b.esbuild} (MIT)` }) + "\n";

export async function packageWeb({ dist = DIST } = {}) {
  fs.mkdirSync(dist, { recursive: true });
  const b = await buildWeb({ outfile: path.join(dist, ARTIFACT) });
  const manifest = manifestFor(b);
  fs.writeFileSync(path.join(dist, MANIFEST), JSON.stringify(manifest, null, 1) + "\n");
  fs.writeFileSync(path.join(dist, NOTICES), noticesOf(b));
  return { ...b, manifest, dist };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  if (a.includes("--out")) { const r = await buildWeb({ outfile: path.resolve(a[a.indexOf("--out") + 1]), minify: !a.includes("--no-minify") }); console.log(`${r.outfile}: ${r.bytes} bytes, sha256 ${r.sha256}, ${r.inputs.length} inputs`); }
  else { const r = await packageWeb(); console.log(`${path.relative(REPO, r.dist)}/: ${ARTIFACT} ${r.bytes} bytes sha256 ${r.sha256}; ${r.inputs.length} inputs in ${MANIFEST}; ${NOTICES} regenerated`); }
}
