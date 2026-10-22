#!/usr/bin/env node
// site/vendor/discovery.js: viem's EIP-191 signature recovery (recoverMessageAddress) and keccak helpers, from this
// repository's own node_modules (viem), as ONE same-origin ESM bundle for the operator-signed statements the default
// independent dashboard checks (site/js/core/host-capacity.js). scripts/build-vendor.mjs has the policy: no CDN bytes.
// The bundle and its manifest are committed with the site; test/site-default-discovery.test.mjs requires them to equal a
// fresh build of the recorded entry.
//   node scripts/build-discovery-vendor.mjs [--check]
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const ENTRY = "scripts/vendor/discovery-entry.mjs";
export const OUT = path.join(ROOT, "site", "vendor", "discovery.js");
export const MANIFEST = path.join(ROOT, "site", "vendor", "discovery.MANIFEST.json");
export const EXPORTS = ["recoverMessageAddress", "keccak256", "toHex", "getAddress"];

export async function buildDiscoveryVendor() {
  const r = await build({ entryPoints: [path.join(ROOT, ENTRY)], bundle: true, format: "esm", platform: "browser", target: "es2022",
                          minify: true, legalComments: "eof", write: false, logLevel: "warning", metafile: true, absWorkingDir: ROOT });
  const js = Buffer.from(r.outputFiles[0].contents);
  const inputs = Object.keys(r.metafile.inputs);
  const node = inputs.filter((p) => /^(node:|\(disabled\))/.test(p));
  if (node.length) throw new Error("discovery bundle pulls Node-only inputs: " + node.join(", "));
  const local = inputs.filter((p) => !p.includes("node_modules/"));
  if (local.length !== 1 || path.relative(ROOT, path.resolve(ROOT, local[0])) !== ENTRY) throw new Error("discovery bundle pulls repository files other than its entry: " + local.join(", "));
  const pkg = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", n, "package.json"), "utf8")).version;
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const manifest = { file: "site/vendor/discovery.js", sha256: sha(js), bytes: js.length, entry: ENTRY, entrySha256: sha(fs.readFileSync(path.join(ROOT, ENTRY))),
                     esbuild: pkg("esbuild"), deps: { viem: pkg("viem") }, exports: EXPORTS };
  return { js, manifest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { js, manifest } = await buildDiscoveryVendor();
  if (process.argv.includes("--check")) {
    const same = fs.existsSync(OUT) && Buffer.compare(fs.readFileSync(OUT), js) === 0;
    console.log(same ? "site/vendor/discovery.js matches a fresh build" : "site/vendor/discovery.js DIFFERS from a fresh build");
    process.exit(same ? 0 : 1);
  }
  fs.writeFileSync(OUT, js);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, OUT)} (${js.length} bytes, sha256 ${manifest.sha256.slice(0, 16)}…)`);
}
