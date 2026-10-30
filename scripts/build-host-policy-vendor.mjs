#!/usr/bin/env node
// site/vendor/host-policy.js: the PLATFORM HOST POLICY gate (network/platform-host-policy.mjs: the admin's EIP-712/ERC-1271
// signed policy, the two-key 32-byte AddressBook anchor, the loader with rollback/equivocation refusal, judgeHost) and its
// mirror transport (network/host-policy-mirrors.mjs) - the FROZEN shared core - as ONE same-origin ESM bundle, so the
// independent dashboard enforces EXACTLY the rule the relay, custody, CLI and hosts use -
// no browser re-implementation, no CDN bytes (scripts/build-vendor.mjs has the policy). viem's ABI encoder/decoder is
// exported for the page's quorum-snapshot adapter (site/js/core/host-policy.js). The sources are bundled UNMODIFIED and
// need no shims; any Node built-in or unlisted repository file refuses the build.
// The bundle and its manifest are COMMITTED; test/site-host-policy.test.mjs rebuilds it and requires the committed bytes
// to equal the fresh build.
//   node scripts/build-host-policy-vendor.mjs [--check] [--allow-uncommitted]
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const OUT = path.join(ROOT, "site", "vendor", "host-policy.js");
export const MANIFEST = path.join(ROOT, "site", "vendor", "host-policy.MANIFEST.json");
export const ENTRY = [
  'export { createPlatformHostGate, readPolicyFacts, decodeAnchor, judgeHost, policyDigest, policyTypedData, validatePolicy, POLICY_FORMAT, ANCHOR_KEYS } from "./network/platform-host-policy.mjs";',
  'export { httpPolicyMirrors, validateMirrors, MAX_POLICY_RESPONSE } from "./network/host-policy-mirrors.mjs";',
  'export { encodeFunctionData, decodeFunctionResult } from "viem";',
].join("\n") + "\n";
// the FROZEN shared core only (work/platform-host-policy-interface.txt); the node-runtime adapters are not for the browser
const SOURCES = ["network/platform-host-policy.mjs", "network/host-policy-mirrors.mjs"];

export async function buildHostPolicyVendor() {
  const r = await build({ stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: "host-policy-vendor-entry.mjs", loader: "js" },
                          bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "eof", write: false,
                          logLevel: "warning", metafile: true, absWorkingDir: ROOT });
  const js = Buffer.from(r.outputFiles[0].contents);
  const inputs = Object.keys(r.metafile.inputs).filter((p) => p !== "host-policy-vendor-entry.mjs");
  const node = inputs.filter((p) => /^(node:|\(disabled\))/.test(p));
  if (node.length) throw new Error("host-policy bundle pulls Node-only inputs: " + node.join(", "));
  const local = inputs.filter((p) => !p.includes("node_modules/")).map((p) => path.relative(ROOT, path.resolve(ROOT, p))).sort();
  const unexpected = local.filter((p) => !SOURCES.includes(p));
  if (unexpected.length) throw new Error("host-policy bundle pulls unreviewed repository files: " + unexpected.join(", "));
  for (const s of SOURCES) if (!local.includes(s)) throw new Error("host-policy bundle no longer contains " + s + " (update SOURCES deliberately)");
  const pkg = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", n, "package.json"), "utf8")).version;
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const manifest = { file: "site/vendor/host-policy.js", sha256: sha(js), bytes: js.length, entry: ENTRY, esbuild: pkg("esbuild"),
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
  const { js, manifest } = await buildHostPolicyVendor();
  if (process.argv.includes("--check")) {
    const same = fs.existsSync(OUT) && Buffer.compare(fs.readFileSync(OUT), js) === 0;
    console.log(same ? "site/vendor/host-policy.js matches a fresh build" : "site/vendor/host-policy.js DIFFERS from a fresh build");
    process.exit(same ? 0 : 1);
  }
  const dirty = Object.entries(manifest.sources).filter(([, v]) => v.committedClean !== true).map(([k]) => k);
  if (dirty.length && !process.argv.includes("--allow-uncommitted"))
    throw new Error("refusing to vendor uncommitted sources (review and commit them first, or pass --allow-uncommitted): " + dirty.join(", "));
  fs.writeFileSync(OUT, js);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, OUT)} (${js.length} bytes, sha256 ${manifest.sha256.slice(0, 16)}…)`);
}
