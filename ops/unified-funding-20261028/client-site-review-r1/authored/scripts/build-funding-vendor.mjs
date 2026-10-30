#!/usr/bin/env node
/* ============================================================
   site/vendor/funding.js <- sdk/funding/browser-entry.mjs
   UNREVIEWED SOURCE (client-site-integration-r1).

   The funding client core (client-repair-r4, byte-identical apart
   from import specifiers; see sdk/funding/MANIFEST.json) bundled
   with the site's existing esbuild, the same way the other vendor
   bundles are produced. Refuses to build when any core file
   differs from its manifest hash, and refuses the output when the
   bundle pulls in anything except sdk/funding/* and viem (plus
   viem's own dependencies), or lacks an export the page calls.
   Run from the repository root:  node scripts/build-funding-vendor.mjs
   ============================================================ */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PKG = path.join(ROOT, "sdk", "funding");
const OUT = path.join(ROOT, "site", "vendor", "funding.js");
const sha = (b) => createHash("sha256").update(b).digest("hex");

const manifest = JSON.parse(fs.readFileSync(path.join(PKG, "MANIFEST.json"), "utf8"));
for (const [name, want] of Object.entries(manifest.files)) {
  const got = sha(fs.readFileSync(path.join(PKG, name)));
  if (got !== want) throw new Error(`sdk/funding/${name}: sha256 ${got} != manifest ${want} (refusing to build)`);
}
const present = fs.readdirSync(PKG).filter((f) => f.endsWith(".mjs")).sort();
const listed = Object.keys(manifest.files).filter((f) => f.endsWith(".mjs")).sort();
if (present.join() !== listed.join()) throw new Error(`sdk/funding holds unlisted modules: ${present.join(", ")}`);

const result = await build({
  absWorkingDir: ROOT,                         // metafile input paths are relative to the repository root
  entryPoints: [path.join(PKG, "browser-entry.mjs")],
  bundle: true, format: "esm", platform: "browser", target: ["es2022"],
  minify: false, sourcemap: false, legalComments: "eof", metafile: true,
  outfile: OUT, write: true,
});

const inputs = Object.keys(result.metafile.inputs);
const foreign = inputs.filter((p) => !p.startsWith("sdk/funding/") && !/(^|\/)node_modules\//.test(p));
if (foreign.length) throw new Error(`the funding bundle pulled in non-package sources: ${foreign.join(", ")}`);
const nm = inputs.filter((p) => /(^|\/)node_modules\//.test(p)).map((p) => p.replace(/^.*node_modules\//, "").split("/").slice(0, p.includes("node_modules/@") ? 2 : 1).join("/"));
const pkgs = [...new Set(nm)].sort();
if (!pkgs.includes("viem")) throw new Error("the funding bundle does not contain viem");

const MUST = ["relayClient", "jsonRpc", "parseRuntimePins", "controlsTarget", "verifyRuntime", "freshRecoveryScope", "selectGasRecord",
  "quoteGasFund", "confirmGasFund", "endGasSession", "ownerControl", "IndexedDbV2Store", "legacyChain", "loadLegacyEvidence",
  "buildMigrationPlan", "signSteps", "runMigration", "reconcileMigration", "rearmStep", "appScopeOf"];
const src = fs.readFileSync(OUT, "utf8");
const exp = (src.match(/export\s*\{[^}]*\}/g) || []).join(",");
const missing = MUST.filter((n) => !new RegExp(`\\b${n}\\b`).test(exp));
if (missing.length) throw new Error(`funding.js lacks exports: ${missing.join(", ")}`);
console.log(`[vendor] funding.js: ${fs.statSync(OUT).size} bytes, sha256 ${sha(fs.readFileSync(OUT))}`);
console.log(`[vendor] funding.js node_modules packages: ${pkgs.join(", ")}`);
