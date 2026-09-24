#!/usr/bin/env node
// verifier/web/build.mjs: bundle verifier/web/index.mjs for a page. Same-origin delivery is the caller's (the site's vendor
// rule, scripts/build-vendor.mjs); this only produces the file, deterministically, from the pinned esbuild.
//   node verifier/web/build.mjs [--out FILE] [--no-minify]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "..", "..");
export async function buildWeb({ outfile = path.join(HERE, "dist", "enclave-verifier-web.js"), minify = true } = {}) {
  const r = await build({
    entryPoints: [path.join(HERE, "index.mjs")], outfile, bundle: true, format: "esm", platform: "browser", target: ["es2022"], minify,
    absWorkingDir: REPO, logLevel: "warning", metafile: true,
    alias: { "node:crypto": path.join(HERE, "shims", "node-crypto.mjs"), "node:zlib": path.join(HERE, "shims", "node-zlib.mjs") },
    inject: [path.join(HERE, "shims", "buffer-global.mjs")],
  });
  return { outfile, bytes: Object.values(r.metafile.outputs)[0].bytes, inputs: Object.keys(r.metafile.inputs) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), out = a.includes("--out") ? a[a.indexOf("--out") + 1] : undefined;
  const r = await buildWeb({ outfile: out, minify: !a.includes("--no-minify") });
  console.log(`${r.outfile}: ${r.bytes} bytes from ${r.inputs.length} inputs`);
}
