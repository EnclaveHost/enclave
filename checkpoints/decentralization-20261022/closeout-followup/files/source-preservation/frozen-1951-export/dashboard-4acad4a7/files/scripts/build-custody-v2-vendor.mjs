#!/usr/bin/env node
// site/vendor/custody-v2.js: custody v2 for the dashboard Secrets panel (site/js/core/custody-v2.js) as
// ONE same-origin ESM bundle of custody/v2/browser.mjs - the agreed chain reader, the reviewed vault table, the rules parsers
// and the owner bundle code that the CLI runs, byte for byte - with no CDN bytes (scripts/build-vendor.mjs has
// the policy). The bundle and its manifest are COMMITTED; test/custody-v2-dashboard.test.mjs rebuilds it and requires the
// committed bytes to equal the fresh build, and every repository source in it to be one of SOURCES with its recorded hash.
//   No Node built-in and no shim: none of SOURCES imports a node: module or uses Buffer (a node: input is refused below).
//   Writing the bundle from uncommitted (unreviewed) sources is refused unless --allow-uncommitted is given.
//   node scripts/build-custody-v2-vendor.mjs [--check] [--allow-uncommitted]
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const OUT = path.join(ROOT, "site", "vendor", "custody-v2.js");
export const MANIFEST = path.join(ROOT, "site", "vendor", "custody-v2.MANIFEST.json");
export const ENTRY = "custody/v2/browser.mjs";
// every repository file the bundle is built from (a build that pulls any other is refused)
export const SOURCES = Object.freeze([ENTRY, "custody/v2/chain.mjs", "custody/v2/quorum.mjs", "custody/v2/owner.mjs", "custody/v2/protocol.mjs",
  "custody/rules.mjs", "custody/protocol.mjs", "custody/hpke.mjs", "custody/threshold.mjs",
  "network/custody-vaults.mjs", "network/platform-host-policy.mjs", "network/rpc-identity.mjs"]);

export async function buildCustodyV2Vendor() {
  const r = await build({ entryPoints: [path.join(ROOT, ENTRY)], bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true,
                          legalComments: "eof", write: false, logLevel: "warning", metafile: true, absWorkingDir: ROOT });
  const js = Buffer.from(r.outputFiles[0].contents);
  const inputs = Object.keys(r.metafile.inputs);
  const node = inputs.filter((p) => /^(node:|\(disabled\))/.test(p));
  if (node.length) throw new Error("custody-v2 bundle pulls Node-only inputs: " + node.join(", "));
  const local = inputs.filter((p) => !p.includes("node_modules/")).map((p) => path.relative(ROOT, path.resolve(ROOT, p))).sort();
  const unexpected = local.filter((p) => !SOURCES.includes(p));
  if (unexpected.length) throw new Error("custody-v2 bundle pulls unreviewed repository files: " + unexpected.join(", "));
  const pkg = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", n, "package.json"), "utf8")).version;
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const manifest = { file: "site/vendor/custody-v2.js", sha256: sha(js), bytes: js.length, entry: ENTRY, esbuild: pkg("esbuild"),
                     deps: Object.fromEntries(["viem", "@noble/curves", "@noble/hashes", "@noble/ciphers"].map((n) => [n, pkg(n)])),
                     sources: Object.fromEntries(local.map((p) => [p, { sha256: sha(fs.readFileSync(path.join(ROOT, p))) }])) };
  return { js, manifest };
}

/* whether each source equals its last commit (false outside a git checkout, or when it differs or is untracked) */
function committedClean(p){
  const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try { if (!git("ls-files", "--", p)) return false; git("diff", "--quiet", "HEAD", "--", p); return true; } catch { return false; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { js, manifest } = await buildCustodyV2Vendor();
  if (process.argv.includes("--check")) {
    const same = fs.existsSync(OUT) && Buffer.compare(fs.readFileSync(OUT), js) === 0
      && fs.existsSync(MANIFEST) && fs.readFileSync(MANIFEST, "utf8") === JSON.stringify(manifest, null, 2) + "\n";
    console.log(same ? "site/vendor/custody-v2.js and its manifest match a fresh build" : "site/vendor/custody-v2.js or its manifest DIFFERS from a fresh build");
    process.exit(same ? 0 : 1);
  }
  const dirty = Object.keys(manifest.sources).filter((p) => !committedClean(p));
  if (dirty.length && !process.argv.includes("--allow-uncommitted"))
    throw new Error("refusing to vendor uncommitted sources (review and commit them first, or pass --allow-uncommitted): " + dirty.join(", "));
  fs.writeFileSync(OUT, js);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, OUT)} (${js.length} bytes, sha256 ${manifest.sha256.slice(0, 16)}…)`);
}
