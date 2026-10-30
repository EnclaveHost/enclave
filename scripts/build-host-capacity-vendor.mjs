#!/usr/bin/env node
// site/vendor/host-capacity.js: the host capacity record READER (network/host-capacity.mjs and what it imports: the record
// shape, bounds and message, canonical JSON, viem's keccak and signature recovery, replay/equivocation floors) as ONE
// same-origin ESM bundle, so the independent dashboard verifies operator-signed capacity records with exactly the code the
// relay and the CLI run - no copied or re-implemented verifier, no CDN bytes (scripts/build-vendor.mjs has the policy).
// The sources are bundled UNMODIFIED. Their two Node-only uses are replaced by reviewed shims in
// scripts/host-capacity-vendor/: node:crypto (sha256 hex of UTF-8 text, for the floors) and Buffer.byteLength (UTF-8
// length, for the 32 KiB bound); any other Node built-in or unlisted repository file refuses the build.
// The bundle and its manifest are COMMITTED; test/site-host-liveness.test.mjs rebuilds it and requires the committed bytes
// to equal the fresh build, and compares the shims with Node.
// The liveness RULE itself (network/host-liveness.mjs) has no imports and is imported by the site directly, not bundled here.
//   node scripts/build-host-capacity-vendor.mjs [--check] [--allow-uncommitted]
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const OUT = path.join(ROOT, "site", "vendor", "host-capacity.js");
export const MANIFEST = path.join(ROOT, "site", "vendor", "host-capacity.MANIFEST.json");
const SHIMS = { crypto: "scripts/host-capacity-vendor/node-crypto-shim.mjs", buffer: "scripts/host-capacity-vendor/buffer-shim.mjs" };
// the READER only: the host side (network/host-capacity-producer.mjs) is not bundled; the two request paths the site
// uses are pinned to the producer's exports by test/site-host-liveness.test.mjs
export const ENTRY = 'export { verifyHostCapacity, validateHostCapacityRecord, CapacityFloors, chooseRecord, aggregateCapacity, hostIdOf, hostCapacityHash, HOST_CAPACITY_MAX_MS } from "./network/host-capacity.mjs";\n';
// every repository file the bundle may be built from, hashed into the manifest
const SOURCES = ["network/host-capacity.mjs", "network/host-capacity-record.mjs", "network/canonical.mjs", SHIMS.crypto, SHIMS.buffer];

const shims = {
  name: "host-capacity-browser-shims",
  setup(b) {
    b.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: path.join(ROOT, SHIMS.crypto) }));
  },
};

export async function buildHostCapacityVendor() {
  const r = await build({ stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: "host-capacity-vendor-entry.mjs", loader: "js" },
                          bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "eof", write: false,
                          logLevel: "warning", metafile: true, absWorkingDir: ROOT, plugins: [shims], inject: [path.join(ROOT, SHIMS.buffer)] });
  const js = Buffer.from(r.outputFiles[0].contents);
  const inputs = Object.keys(r.metafile.inputs).filter((p) => p !== "host-capacity-vendor-entry.mjs");
  const node = inputs.filter((p) => /^(node:|\(disabled\))/.test(p));
  if (node.length) throw new Error("host-capacity bundle pulls Node-only inputs: " + node.join(", "));
  const local = inputs.filter((p) => !p.includes("node_modules/")).map((p) => path.relative(ROOT, path.resolve(ROOT, p))).sort();
  const unexpected = local.filter((p) => !SOURCES.includes(p));
  if (unexpected.length) throw new Error("host-capacity bundle pulls unreviewed repository files: " + unexpected.join(", "));
  for (const s of SOURCES) if (!local.includes(s)) throw new Error("host-capacity bundle no longer contains " + s + " (update SOURCES deliberately)");
  const pkg = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", n, "package.json"), "utf8")).version;
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const manifest = { file: "site/vendor/host-capacity.js", sha256: sha(js), bytes: js.length, entry: ENTRY, esbuild: pkg("esbuild"),
                     deps: { viem: pkg("viem") },
                     sources: Object.fromEntries(local.map((p) => [p, { sha256: sha(fs.readFileSync(path.join(ROOT, p))), ...provenance(p) }])) };
  return { js, manifest };
}

/* the last commit touching a source, and whether the working tree still equals it (null outside a git checkout) */
function provenance(p){
  const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const commit = git("log", "-1", "--format=%H", "--", p) || null;
    let clean = true;
    try { git("diff", "--quiet", "HEAD", "--", p); } catch { clean = false; }
    if (!git("ls-files", "--", p)) clean = false;
    return { commit, committedClean: clean };
  } catch { return { commit: null, committedClean: null }; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { js, manifest } = await buildHostCapacityVendor();
  if (process.argv.includes("--check")) {
    const same = fs.existsSync(OUT) && Buffer.compare(fs.readFileSync(OUT), js) === 0;
    console.log(same ? "site/vendor/host-capacity.js matches a fresh build" : "site/vendor/host-capacity.js DIFFERS from a fresh build");
    process.exit(same ? 0 : 1);
  }
  const dirty = Object.entries(manifest.sources).filter(([, v]) => v.committedClean !== true).map(([k]) => k);
  if (dirty.length && !process.argv.includes("--allow-uncommitted"))
    throw new Error("refusing to vendor uncommitted sources (review and commit them first, or pass --allow-uncommitted): " + dirty.join(", "));
  fs.writeFileSync(OUT, js);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, OUT)} (${js.length} bytes, sha256 ${manifest.sha256.slice(0, 16)}…)`);
}
