#!/usr/bin/env node
// site/vendor/credit-vault.js: viem ABI helpers, ox WebAuthn P-256 and @noble P-256/SHA-256, from this repository's own
// node_modules, as ONE same-origin ESM bundle for the independent credit-vault client (site/credit/; scripts/build-vendor.mjs
// has the policy: no CDN bytes). The bundle and its manifest are COMMITTED; test/credit-vault-independent.test.mjs
// requires the committed bytes to equal a fresh build. Separate from site/vendor/aa.js, which stays byte-identical.
//   node scripts/build-credit-vault-vendor.mjs [--check]
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const ENTRY = "scripts/vendor/credit-vault-entry.mjs";
export const OUT = path.join(ROOT, "site", "vendor", "credit-vault.js");
export const MANIFEST = path.join(ROOT, "site", "vendor", "credit-vault.MANIFEST.json");
export const EXPORTS = ["encodeFunctionData", "decodeFunctionData", "decodeFunctionResult", "encodeAbiParameters", "decodeAbiParameters", "keccak256",
  "getAddress", "concat", "pad", "toHex", "hexToBytes", "bytesToHex", "toFunctionSelector", "WebAuthnP256", "p256", "sha256"];

export async function buildCreditVaultVendor() {
  const r = await build({ entryPoints: [path.join(ROOT, ENTRY)], bundle: true, format: "esm", platform: "browser", target: "es2022",
                          minify: true, legalComments: "eof", write: false, logLevel: "warning", metafile: true, absWorkingDir: ROOT });
  const js = Buffer.from(r.outputFiles[0].contents);
  const inputs = Object.keys(r.metafile.inputs);
  const node = inputs.filter((p) => /^(node:|\(disabled\))/.test(p));
  if (node.length) throw new Error("credit-vault bundle pulls Node-only inputs: " + node.join(", "));
  const local = inputs.filter((p) => !p.includes("node_modules/"));
  if (local.length !== 1 || path.relative(ROOT, path.resolve(ROOT, local[0])) !== ENTRY) throw new Error("credit-vault bundle pulls repository files other than its entry: " + local.join(", "));
  const pkg = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", n, "package.json"), "utf8")).version;
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const manifest = { file: "site/vendor/credit-vault.js", sha256: sha(js), bytes: js.length, entry: ENTRY, entrySha256: sha(fs.readFileSync(path.join(ROOT, ENTRY))),
                     esbuild: pkg("esbuild"), deps: { viem: pkg("viem"), ox: pkg("ox"), "@noble/curves": pkg("@noble/curves"), "@noble/hashes": pkg("@noble/hashes") }, exports: EXPORTS };
  return { js, manifest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { js, manifest } = await buildCreditVaultVendor();
  if (process.argv.includes("--check")) {
    const same = fs.existsSync(OUT) && Buffer.compare(fs.readFileSync(OUT), js) === 0;
    console.log(same ? "site/vendor/credit-vault.js matches a fresh build" : "site/vendor/credit-vault.js DIFFERS from a fresh build");
    process.exit(same ? 0 : 1);
  }
  fs.writeFileSync(OUT, js);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, OUT)} (${js.length} bytes, sha256 ${manifest.sha256.slice(0, 16)}…)`);
}
