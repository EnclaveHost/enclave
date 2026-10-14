#!/usr/bin/env node
// site/vendor/custody.js: the owner-side custody code (custody/browser.mjs and what it imports: @noble/*, viem's ABI and
// RPC pieces) as ONE same-origin ESM bundle, so a page that encrypts secrets runs no CDN bytes (scripts/build-vendor.mjs has
// the policy). The bundle and its manifest are COMMITTED; test/custody-browser.test.mjs rebuilds it and requires the
// committed bytes to equal the fresh build, so the file the site serves is exactly this repository's code.
//   node scripts/build-custody-vendor.mjs [--check]
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const OUT = path.join(ROOT, "site", "vendor", "custody.js");
export const MANIFEST = path.join(ROOT, "site", "vendor", "custody.MANIFEST.json");

export async function buildCustodyVendor() {
  const r = await build({ entryPoints: [path.join(ROOT, "custody", "browser.mjs")], bundle: true, format: "esm", platform: "browser",
                          target: "es2022", minify: true, legalComments: "eof", write: false, logLevel: "warning" });
  const js = Buffer.from(r.outputFiles[0].contents);
  const pkg = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", n, "package.json"), "utf8")).version;
  const manifest = { file: "site/vendor/custody.js", sha256: createHash("sha256").update(js).digest("hex"), bytes: js.length,
                     entry: "custody/browser.mjs", esbuild: pkg("esbuild"),
                     deps: { "@noble/curves": pkg("@noble/curves"), "@noble/hashes": pkg("@noble/hashes"), "@noble/ciphers": pkg("@noble/ciphers"), viem: pkg("viem") } };
  return { js, manifest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { js, manifest } = await buildCustodyVendor();
  if (process.argv.includes("--check")) {
    const same = fs.existsSync(OUT) && Buffer.compare(fs.readFileSync(OUT), js) === 0;
    console.log(same ? "site/vendor/custody.js matches a fresh build" : "site/vendor/custody.js DIFFERS from a fresh build");
    process.exit(same ? 0 : 1);
  }
  fs.writeFileSync(OUT, js);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, OUT)} (${js.length} bytes, sha256 ${manifest.sha256.slice(0, 16)}…)`);
}
