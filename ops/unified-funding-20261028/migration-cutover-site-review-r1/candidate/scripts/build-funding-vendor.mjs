#!/usr/bin/env node
/* ============================================================
   site/vendor/funding.js <- sdk/funding/browser-entry.mjs
   UNREVIEWED SOURCE (client-site-repair-r2; repairs r1).

   The funding client core (client-repair-r4, byte-identical apart
   from import specifiers; see sdk/funding/MANIFEST.json) bundled
   with the site's existing esbuild. Nothing is written until every
   check passed:
     1. every sdk/funding file matches its manifest hash, and no
        unlisted module exists there;
     2. the bundle is built IN MEMORY (write: false);
     3. its inputs are only sdk/funding/* and node_modules packages
        in the ALLOWLIST: viem plus viem's declared dependency
        closure, read from the installed package.json files (so the
        list is what viem itself declares, nothing else);
     4. it exports every name the /funding page calls.
   Then site/vendor/funding.js and site/vendor/funding.manifest.json
   (bundle sha256 + sdk/funding/MANIFEST.json sha256 + packages) are
   written; scripts/build-site.mjs refuses a bundle that does not
   match that manifest or the current core.
   Run from anywhere:  node scripts/build-funding-vendor.mjs
   (scripts/build-vendor.mjs also runs it after it empties
   site/vendor/).
   ============================================================ */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PKG = path.join(ROOT, "sdk", "funding");
const OUT_DIR = path.join(ROOT, "site", "vendor");
const OUT = path.join(OUT_DIR, "funding.js");
const SIDE = path.join(OUT_DIR, "funding.manifest.json");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const refuse = (m) => { throw new Error(`build-funding-vendor: ${m} (refusing to build; nothing written)`); };

// 1. the pinned core
const manifestBytes = fs.readFileSync(path.join(PKG, "MANIFEST.json"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
for (const [name, want] of Object.entries(manifest.files)) {
  const got = sha(fs.readFileSync(path.join(PKG, name)));
  if (got !== want) refuse(`sdk/funding/${name}: sha256 ${got} != manifest ${want}`);
}
const present = fs.readdirSync(PKG).filter((f) => f !== "MANIFEST.json").sort();
const listed = Object.keys(manifest.files).sort();
if (present.join() !== listed.join()) refuse(`sdk/funding holds unlisted files: [${present.filter((f) => !listed.includes(f))}]`);

// 3a. the allowlist: viem + the dependency closure its installed package.json files declare
const pkgJson = (name) => {
  const p = path.join(ROOT, "node_modules", ...name.split("/"), "package.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
};
const ALLOW = new Set();
const queue = ["viem"];
while (queue.length) {
  const n = queue.shift();
  if (ALLOW.has(n)) continue;
  ALLOW.add(n);
  const j = pkgJson(n);
  if (!j) { if (n === "viem") refuse("node_modules/viem is not installed"); continue; }
  for (const d of Object.keys({ ...(j.dependencies || {}), ...(j.peerDependencies || {}) })) queue.push(d);
}

// 2. build in memory
const result = await build({
  absWorkingDir: ROOT,                         // metafile input paths are relative to the repository root
  entryPoints: [path.join(PKG, "browser-entry.mjs")],
  bundle: true, format: "esm", platform: "browser", target: ["es2022"],
  minify: false, sourcemap: false, legalComments: "eof", metafile: true,
  outfile: OUT, write: false,
});
if (result.errors?.length) refuse(`esbuild reported ${result.errors.length} error(s)`);
const files = result.outputFiles.filter((f) => path.resolve(f.path) === OUT);
if (files.length !== 1 || result.outputFiles.length !== 1) refuse(`expected exactly one output file, got [${result.outputFiles.map((f) => f.path)}]`);
const bytes = Buffer.from(files[0].contents);

// 3b. inputs: sdk/funding/* or an allowlisted package (the LAST node_modules segment names the package)
const inputs = Object.keys(result.metafile.inputs);
const pkgOf = (p) => {
  const rest = p.slice(p.lastIndexOf("node_modules/") + "node_modules/".length).split("/");
  return rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
};
const foreign = inputs.filter((p) => !p.startsWith("sdk/funding/") && !p.includes("node_modules/"));
if (foreign.length) refuse(`the bundle pulled in non-package sources: [${foreign}]`);
const pkgs = [...new Set(inputs.filter((p) => p.includes("node_modules/")).map(pkgOf))].sort();
const notAllowed = pkgs.filter((p) => !ALLOW.has(p));
if (notAllowed.length) refuse(`packages outside viem's declared dependency closure: [${notAllowed}]`);
if (!pkgs.includes("viem")) refuse("the bundle does not contain viem");
const core = inputs.filter((p) => p.startsWith("sdk/funding/")).map((p) => p.slice("sdk/funding/".length)).sort();
const unlisted = core.filter((f) => !listed.includes(f));
if (unlisted.length) refuse(`bundle inputs outside the manifest: [${unlisted}]`);

// 4. exports the page calls
const MUST = ["relayClient", "jsonRpc", "parseRuntimePins", "controlsTarget", "verifyRuntime", "freshRecoveryScope", "selectGasRecord",
  "quoteGasFund", "confirmGasFund", "endGasSession", "ownerControl", "IndexedDbV2Store", "legacyChain", "loadLegacyEvidence",
  "buildMigrationPlan", "signSteps", "runMigration", "reconcileMigration", "rearmStep",
  "reconcileGasExecution", "listGasExecutions", "PRE_FUNDING_API", "resumeCutover"];   // client-execution-site-r2: the recovery UI calls these
const text = bytes.toString("utf8");
const exp = (text.match(/export\s*\{[^}]*\}/g) || []).join(",");
const missing = MUST.filter((n) => !new RegExp(`(^|[\\s,{])(${n}|\\w+ as ${n})\\s*(,|\\}|$)`, "m").test(exp));
if (missing.length) refuse(`funding.js lacks exports: [${missing}]`);

// all checks passed: write the bundle, then its manifest
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, bytes);
const side = { schema: "enclave-funding-vendor-r1", bundle: "funding.js", bundleSha256: sha(bytes),
  coreManifestSha256: sha(manifestBytes), packages: pkgs, allowlist: [...ALLOW].sort() };
fs.writeFileSync(SIDE, `${JSON.stringify(side, null, 2)}\n`);
console.log(`[vendor] funding.js: ${bytes.length} bytes, sha256 ${side.bundleSha256}; packages ${pkgs.join(", ")}`);
