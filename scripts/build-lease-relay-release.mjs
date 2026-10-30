#!/usr/bin/env node
// A standalone lease relay release (network/lease-relay-service.mjs; docs/network/lease-relay-release.md), built from
// THIS repository: one esbuild bundle (no node_modules beside it), its input manifest, and the dependency-free
// configuration check the service unit runs before every start.
//   node scripts/build-lease-relay-release.mjs OUTDIR [--expect-sha256 HEX]
// OUTDIR/lease-relay.mjs         the service (node >= 20); same options as the reviewed root build, so the same inputs
//                                give the same bytes
// OUTDIR/lease-relay-check.mjs   network/lease-relay-check.mjs, copied verbatim (no imports)
// OUTDIR/manifest.json           sha256/bytes of both, and the sha256 of every bundled input
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
  console.error("usage: node scripts/build-lease-relay-release.mjs OUTDIR [--expect-sha256 HEX]"); process.exit(2);
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
// preserveSymlinks: inputs keep their repository-relative paths even in a checkout built from links (in a plain checkout
// it changes nothing; the bundle embeds no module paths either way)
const r = await build({ absWorkingDir: ROOT, entryPoints: ["network/lease-relay-service.mjs"], platform: "node", format: "esm", target: "node20",
  bundle: true, minify: true, write: false, metafile: true, preserveSymlinks: true });
const bundle = Buffer.from(r.outputFiles[0].contents), check = fs.readFileSync(path.join(ROOT, "network/lease-relay-check.mjs"));
const inputs = {};
for (const rel of Object.keys(r.metafile.inputs).sort()) inputs[rel] = sha(fs.readFileSync(path.resolve(ROOT, rel)));
const manifest = { format: "enclave-lease-relay-release/v1", nodeTarget: "node20", entry: "network/lease-relay-service.mjs",
  artifact: { file: "lease-relay.mjs", sha256: sha(bundle), bytes: bundle.length },
  check: { file: "lease-relay-check.mjs", sha256: sha(check), bytes: check.length }, inputs };
if (expect && manifest.artifact.sha256 !== expect) { console.error(`lease-relay.mjs is ${manifest.artifact.sha256}, not the expected ${expect}: not written`); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "lease-relay.mjs"), bundle);
fs.writeFileSync(path.join(out, "lease-relay-check.mjs"), check);
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
console.log(JSON.stringify({ out, artifact: manifest.artifact, check: manifest.check, inputs: Object.keys(inputs).length }));
