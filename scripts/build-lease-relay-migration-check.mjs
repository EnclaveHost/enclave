#!/usr/bin/env node
// The relay migration gate as ONE standalone file (network/lease-relay-migration-check.mjs; no node_modules beside it), built
// with the same esbuild options as scripts/build-lease-relay-release.mjs, so the same inputs give the same bytes.
//   node scripts/build-lease-relay-migration-check.mjs OUTDIR [--expect-sha256 HEX]
// OUTDIR/lease-relay-migration-check.mjs and OUTDIR/lease-relay-migration-check.manifest.json (sha256 of every input).
// Nothing here reads a key, contacts an RPC or starts a service.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2), out = args[0] && !args[0].startsWith("--") ? path.resolve(args[0]) : null;
const ex = args.indexOf("--expect-sha256"), expect = ex >= 0 ? String(args[ex + 1] || "") : null;
if (!out || (expect !== null && !/^[0-9a-f]{64}$/.test(expect))) {
  console.error("usage: node scripts/build-lease-relay-migration-check.mjs OUTDIR [--expect-sha256 HEX]"); process.exit(2);
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const r = await build({ absWorkingDir: ROOT, entryPoints: ["network/lease-relay-migration-check.mjs"], platform: "node", format: "esm", target: "node20",
  bundle: true, minify: true, write: false, metafile: true, preserveSymlinks: true });
const bundle = Buffer.from(r.outputFiles[0].contents);
const inputs = {};
for (const rel of Object.keys(r.metafile.inputs).sort()) inputs[rel] = sha(fs.readFileSync(path.resolve(ROOT, rel)));
const manifest = { format: "enclave-lease-relay-migration-check/v1", nodeTarget: "node20", entry: "network/lease-relay-migration-check.mjs",
  artifact: { file: "lease-relay-migration-check.mjs", sha256: sha(bundle), bytes: bundle.length }, inputs };
if (expect && manifest.artifact.sha256 !== expect) { console.error(`lease-relay-migration-check.mjs is ${manifest.artifact.sha256}, not the expected ${expect}: not written`); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "lease-relay-migration-check.mjs"), bundle);
fs.writeFileSync(path.join(out, "lease-relay-migration-check.manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
console.log(JSON.stringify({ out, artifact: manifest.artifact, inputs: Object.keys(inputs).length }));
