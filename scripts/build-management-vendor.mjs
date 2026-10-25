#!/usr/bin/env node
// site/vendor/management.js: the browser transport for independent host management (network/management-browser.mjs and
// what it imports: the management record, route table and outcome rules, canonical JSON, the address guard and viem's
// hashing and signature recovery) as ONE same-origin ESM bundle, so the independent dashboard verifies operator records and
// talks to a host's management gateway with exactly the code the native client and the gateway share - and no CDN bytes
// (scripts/build-vendor.mjs has the policy). The bundle and its manifest are COMMITTED; test/site-independent-management
// .test.mjs rebuilds it and requires the committed bytes to equal the fresh build.
// Provenance: each source's sha256 plus the last commit that touched it and whether the working tree still equals that
// commit; writing the bundle from uncommitted (unreviewed) sources is refused unless --allow-uncommitted is given.
//   node scripts/build-management-vendor.mjs [--check] [--allow-uncommitted]
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const OUT = path.join(ROOT, "site", "vendor", "management.js");
export const MANIFEST = path.join(ROOT, "site", "vendor", "management.MANIFEST.json");
export const ENTRY = "network/management-browser.mjs";
// every repository file the bundle is built from, hashed into the manifest so a reviewer can see which sources it carries
const SOURCES = [ENTRY, "network/management-record.mjs", "network/management-routes.mjs", "network/management-outcome.mjs",
  "network/canonical.mjs", "net-guard.mjs"];   // relay/net-guard.mjs is a symlink to ../net-guard.mjs

export async function buildManagementVendor() {
  const r = await build({ entryPoints: [path.join(ROOT, ENTRY)], bundle: true, format: "esm", platform: "browser",
                          target: "es2022", minify: true, legalComments: "eof", write: false, logLevel: "warning", metafile: true,
                          absWorkingDir: ROOT });
  const js = Buffer.from(r.outputFiles[0].contents);
  // browser-safe means no Node built-in reached the bundle
  const inputs = Object.keys(r.metafile.inputs);
  const node = inputs.filter((p) => /^(node:|\(disabled\))/.test(p));
  if (node.length) throw new Error("management bundle pulls Node-only inputs: " + node.join(", "));
  const local = inputs.filter((p) => !p.includes("node_modules/")).map((p) => path.relative(ROOT, path.resolve(ROOT, p))).sort();
  const unexpected = local.filter((p) => !SOURCES.includes(p));
  if (unexpected.length) throw new Error("management bundle pulls unreviewed repository files: " + unexpected.join(", "));
  const pkg = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", n, "package.json"), "utf8")).version;
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const manifest = { file: "site/vendor/management.js", sha256: sha(js), bytes: js.length, entry: ENTRY, esbuild: pkg("esbuild"),
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
  const { js, manifest } = await buildManagementVendor();
  if (process.argv.includes("--check")) {
    const same = fs.existsSync(OUT) && Buffer.compare(fs.readFileSync(OUT), js) === 0;
    console.log(same ? "site/vendor/management.js matches a fresh build" : "site/vendor/management.js DIFFERS from a fresh build");
    process.exit(same ? 0 : 1);
  }
  const dirty = Object.entries(manifest.sources).filter(([, v]) => v.committedClean !== true).map(([k]) => k);
  if (dirty.length && !process.argv.includes("--allow-uncommitted"))
    throw new Error("refusing to vendor uncommitted sources (review and commit them first, or pass --allow-uncommitted): " + dirty.join(", "));
  fs.writeFileSync(OUT, js);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, OUT)} (${js.length} bytes, sha256 ${manifest.sha256.slice(0, 16)}…)`);
}
