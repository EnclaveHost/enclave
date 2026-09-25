#!/usr/bin/env node
// verifier/node/build.mjs: the Node consumer bundle, packaged reproducibly, the way verifier/web/build.mjs packages the
// browser one. ONE file carries verifier/consumer.mjs with everything it imports (this tree's verifier modules,
// relay/snp-verify.mjs, @freedomofpress/sigstore-browser and the pinned Sigstore root), so a consumer that ships a subset of
// this repository still runs exactly this verifier: the enclave image (Dockerfile copies files by name), the relay (its
// deploy ships relay/** only: relay/vendor/ holds a byte-identical copy), and the CLI (cli/build.mjs bundles it in).
//   node verifier/node/build.mjs            -> verifier/dist/{enclave-verifier-node.mjs, MANIFEST.json, THIRD-PARTY-NOTICES.md}
//                                              + relay/vendor/enclave-verifier-node.mjs (+ .MANIFEST.json), byte-identical
//   node verifier/node/build.mjs --out FILE -> one ad-hoc bundle, nothing else written
// @tinfoilsh/verifier stays EXTERNAL: the reference leg imports it at run time where it is installed (the enclave image,
// the CLI) and reports installed:false where it is not (the relay), never a silent pass. Node built-ins are external.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build, version as esbuildVersion } from "esbuild";
import { noticesFor } from "../web/notices.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "..", "..");
export const DIST = path.join(REPO, "verifier", "dist"), ARTIFACT = "enclave-verifier-node.mjs", MANIFEST = "MANIFEST.json", NOTICES = "THIRD-PARTY-NOTICES.md";
export const VENDOR = path.join(REPO, "relay", "vendor"), VENDOR_MANIFEST = "enclave-verifier-node.MANIFEST.json";
export const OPTIONS = Object.freeze({ entry: "verifier/consumer.mjs", format: "esm", platform: "node", target: "node20", minify: false, external: ["@tinfoilsh/verifier"] });
const sha = (b) => createHash("sha256").update(b).digest("hex");

export async function buildNode({ outfile = path.join(DIST, ARTIFACT), minify = OPTIONS.minify } = {}) {
  const r = await build({
    entryPoints: [path.join(REPO, OPTIONS.entry)], outfile, bundle: true, format: OPTIONS.format, platform: OPTIONS.platform, target: [OPTIONS.target], minify,
    external: [...OPTIONS.external], absWorkingDir: REPO, logLevel: "warning", metafile: true, legalComments: "none",
    banner: { js: "// enclave-verifier-node: built by verifier/node/build.mjs from the inputs in MANIFEST.json; do not edit by hand" },
  });
  const out = fs.readFileSync(outfile);
  const inputs = Object.keys(r.metafile.inputs).sort().map((p) => ({ path: p, bytes: r.metafile.inputs[p].bytes, sha256: sha(fs.readFileSync(path.join(REPO, p))) }));
  return { outfile, bytes: out.length, sha256: sha(out), inputs, esbuild: esbuildVersion };
}
export const manifestFor = (b) => ({ artifact: { file: ARTIFACT, bytes: b.bytes, sha256: b.sha256 }, build: { tool: "esbuild", version: b.esbuild, ...OPTIONS }, inputs: b.inputs });
export const noticesOf = (b) => noticesFor(b.inputs.map((i) => i.path), { repo: REPO, tool: `esbuild ${b.esbuild} (MIT)` }) + "\n";

export async function packageNode({ dist = DIST, vendor = VENDOR } = {}) {
  fs.mkdirSync(dist, { recursive: true });
  const b = await buildNode({ outfile: path.join(dist, ARTIFACT) });
  const manifest = manifestFor(b);
  fs.writeFileSync(path.join(dist, MANIFEST), JSON.stringify(manifest, null, 1) + "\n");
  fs.writeFileSync(path.join(dist, NOTICES), noticesOf(b));
  if (vendor) {
    fs.mkdirSync(vendor, { recursive: true });
    fs.copyFileSync(path.join(dist, ARTIFACT), path.join(vendor, ARTIFACT));
    fs.writeFileSync(path.join(vendor, VENDOR_MANIFEST), JSON.stringify({ copiedFrom: path.relative(REPO, path.join(dist, ARTIFACT)), artifact: manifest.artifact, build: manifest.build }, null, 1) + "\n");
  }
  return { ...b, manifest, dist, vendor };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  if (a.includes("--out")) { const r = await buildNode({ outfile: path.resolve(a[a.indexOf("--out") + 1]), minify: a.includes("--minify") }); console.log(`${r.outfile}: ${r.bytes} bytes, sha256 ${r.sha256}, ${r.inputs.length} inputs`); }
  else { const r = await packageNode(); console.log(`${path.relative(REPO, r.dist)}/: ${ARTIFACT} ${r.bytes} bytes sha256 ${r.sha256}; ${r.inputs.length} inputs in ${MANIFEST}; ${NOTICES} regenerated; copy in ${path.relative(REPO, r.vendor)}/`); }
}
