#!/usr/bin/env node
/* ============================================================
   funding-cutover-r1 isolated SOURCE OVERLAY (the build.mjs --source).
   Copies ONLY the 33 files the qualified r2 addon build read (its
   reviewed pins) into a NEW directory:
     26 baseline files from ../../source, byte-identical (r2 reviewed sha256)
      6 tested candidate files from ../migration-cutover-site-review-r1/candidate
        (page, state, flows, vendor funding.js + funding.manifest.json, sdk/funding/MANIFEST.json)
      1 site/js/core/config.js = baseline + two `= null` exports (exact, reversible)
   Every input is verified BEFORE anything is written. The destination must
   not exist. No symlinks, no package.json/node_modules (esbuild is resolved by
   build.mjs --deps). Originals are re-hashed afterwards (unchanged).
   OVERLAY-MANIFEST.json records each original and output sha256 + the patch.

     node make-overlay.mjs --out DIR [--source S] [--candidate C]
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as L from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = {
  source: path.resolve(HERE, "../../source"),
  candidate: path.resolve(HERE, "../migration-cutover-site-review-r1/candidate"),
};
const ADDON_R2 = path.resolve(HERE, "../production-site-addon-r2");
export const OVERLAY_SCHEMA = "enclave-funding-cutover-overlay-r1";

/** Unchanged baseline files: production-site-addon-r2/pins-disabled-reviewed-r1.json. */
export const BASELINE = Object.freeze({
  "site/components/footer/footer.html": "72d95953de2982f62b4efbffec3f6630090bd4839816b93ded4580e9e75905d9",
  "site/components/footer/footer.js": "e316319a3ab3f38af03b341d73370380f53aa0ead1920c82fd7890115eb6b11a",
  "site/components/header/header.html": "efac44b1b8b4a20e7a8b9f9ef9448c6b0c115630e0b8fd66316720d4024a8b42",
  "site/components/header/header.js": "14d77dd2fcbba022fe6d7cad7379bd23ce0eefb0ed9c71e48b76309ef0df35f3",
  "site/components/section-head/section-head.html": "8a666295021b03b6c1ffc11d48d18e5ff2eb59185849722441732602931dcea1",
  "site/components/toast/toast.html": "0e89127f552d48c12139d6eb397c0da1e05dc693b9a16c54fddbc7df31c125ac",
  "site/components/toast/toast.js": "dbafe2e63558454e2b29da08e0486f7c935f10a416f167ae7995b16ddf8e8a9d",
  "site/components/wallet-button/wallet-button.html": "cd77c04b5045cf56920216544a2a7cf8713427d860d0cc41530257383c4ea2a8",
  "site/components/wallet-button/wallet-button.js": "c7fec3deb421dc3c7c20501c2f75c76aa2f1655aa34d097b396116b3f1bbe0ed",
  "site/css/site.css": "4b52a34c258c6cf5469e4f531040b57b826fd04ec16089cec8e35a79e4cdf2b3",
  "site/funding.html": "2f46bebb4e74c2c5840dae57105c3a0c5e1f6c5c47ccdc9ac0c5013769527b66",
  "site/js/core/account.js": "a494c36be529e308d15fa875fc0e967447eea9c6144165436d6b3680bc8fb921",
  "site/js/core/api.js": "cf4cb0d0fb881772e6c93d52a17a80fae50dc12940fb86383cda4b087c5cbf72",
  "site/js/core/chain.js": "8c840ea8a5d6385cfaee5ba0e63a125ae50c6fe910dd749a4fcd45c7f6acaebf",
  "site/js/core/keccak.js": "ee3929ff49bd8c5b054fea158fd7e9e0de9de7f29a540d52748410d9d9049bb8",
  "site/js/core/ledger-calls.js": "ec6b2780dcf1b6213ecddc03504e311961caf5f881f47d71b5b0da92dc016469",
  "site/js/core/pricing.js": "43f7eceff5a392b7eb99c7dc615a6a132e8ea8c12602ffb472c6551347588af0",
  "site/js/core/runlog.js": "d6868eb5d13905d04c50d84bbb1d6e976b97fb81da8cc4f78b655a514dcf697c",
  "site/js/core/sessions.js": "7242d89951d7df4501991ade3171cdd3a068f14bc9277be8ecdc2e7c47d11c7c",
  "site/js/core/spec.js": "164dae830ba451105f3ff4868a6fe92dd96184101d08eefe9348671624b23116",
  "site/js/core/util.js": "71a896f187d4577c7cf615daf72dac22f705a45dc9058d994d6983f83358d830",
  "site/js/core/vault.js": "a6ab42793d8e36d159a815aad9724969cb00d6433c479132afe83eedd710c8b3",
  "site/js/core/wallet.js": "fff283426c2be5a1a3957e33c4076f32b9e2a3708b7fc075cfca447177f45594",
  "site/js/lib/enclave-element.js": "dc01f1c8a30f92e9922031c20e77eb77b28abb76f8eace0c63c1a999e055c1c8",
  "site/js/lib/qr.js": "0ca06bd4c594dc105da5b364a21674eef3549b1e87eb0ae08ccd135c762238dd",
  "site/vendor/sessions.js": "9dda76f6c22ef102e9dce27b7e61731c83a7e41905a611587578e305bc758997",
});
/** Tested candidate files (root BUILD-PINS / funding.manifest.json). funding.manifest.json is content-checked. */
export const CANDIDATE = Object.freeze({
  "site/js/pages/funding.js": L.QUALIFIED["site/js/pages/funding.js"],
  "site/js/funding/state.js": L.QUALIFIED["site/js/funding/state.js"],
  "site/js/funding/flows.js": L.QUALIFIED["site/js/funding/flows.js"],
  "site/vendor/funding.js": L.QUALIFIED["site/vendor/funding.js"],
  "sdk/funding/MANIFEST.json": L.QUALIFIED["sdk/funding/MANIFEST.json"],
  "site/vendor/funding.manifest.json": null,
});
export const VENDOR_MANIFEST = Object.freeze({
  schema: "enclave-funding-vendor-r1", bundle: "funding.js",
  bundleSha256: L.QUALIFIED["site/vendor/funding.js"], coreManifestSha256: L.QUALIFIED["sdk/funding/MANIFEST.json"],
  packages: ["@noble/curves", "@noble/hashes", "abitype", "isows", "ox", "viem"],
  allowlist: ["@adraffy/ens-normalize", "@noble/ciphers", "@noble/curves", "@noble/hashes", "@scure/base", "@scure/bip32", "@scure/bip39",
    "abitype", "bufferutil", "eventemitter3", "isows", "ox", "typescript", "utf-8-validate", "viem", "ws", "zod"],
});
export const CONFIG = Object.freeze({ path: "site/js/core/config.js", sha256: "3d687efdbedbc826529274866b993e2c60952df495807ae7d0c0099c2effccad" });
const ANCHOR = 'export const FUNDING_MIGRATION_APPROVAL = null;   // { schema: "enclave-funding-migration-approval-r1", rootReviewed: true, termsHash, owner, chainId, oldSid }\n';
/** The only config.js edit: two explicit null exports appended after the approval line (applyExact: once, reversible). */
export const CONFIG_PATCH = Object.freeze([[ANCHOR, ANCHOR
  + "export const FUNDING_MIGRATION_CUTOVER = null;    // funding-cutover-r1: { schema: enclave-funding-migration-cutover-r1, chainId, owner, oldSid, terms } (funding/state.js validateCutover)\n"
  + "export const FUNDING_CUTOVER_ACTIVATION = null;   // funding-cutover-r1: stays null until a reviewed activation record exists after the actual operation\n"]]);

const inside = (root, p) => { const r = path.relative(root, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

export function makeOverlay({ out, source = DEFAULTS.source, candidate = DEFAULTS.candidate }) {
  if (!out) throw new Error("--out is required");
  const OUT = path.resolve(out);
  if (exists(OUT)) throw new Error("destination exists (refused): " + OUT);
  const SRC = fs.realpathSync(source), CAND = fs.realpathSync(candidate);
  for (const root of [SRC, CAND, ADDON_R2]) if (inside(root, OUT)) throw new Error("destination inside a protected tree: " + OUT);
  const parent = path.dirname(OUT);
  if (fs.realpathSync(parent) !== parent) throw new Error("destination parent passes through a symlink: " + parent);

  // ---- 1. read and verify every input; nothing is written yet ----
  const take = (root, rel, want) => {
    const from = path.join(root, rel);
    const bytes = L.readRegular(from);
    const sha = L.sha256(bytes);
    if (want && sha !== want) throw new Error(`${from}: ${sha} is not the pinned ${want}`);
    return { from, bytes, sha };
  };
  const files = [];
  for (const [rel, want] of Object.entries(BASELINE)) { const r = take(SRC, rel, want); files.push({ path: rel, kind: "baseline", from: r.from, originalSha256: r.sha, bytes: r.bytes }); }
  for (const [rel, want] of Object.entries(CANDIDATE)) { const r = take(CAND, rel, want); files.push({ path: rel, kind: "candidate", from: r.from, originalSha256: r.sha, bytes: r.bytes }); }
  const byPath = (rel) => files.find((f) => f.path === rel);
  if (JSON.stringify(JSON.parse(byPath("site/vendor/funding.manifest.json").bytes.toString("utf8"))) !== JSON.stringify(VENDOR_MANIFEST))
    throw new Error("candidate site/vendor/funding.manifest.json is not the tested vendor manifest");
  // the tested core files the vendor was built from (verified in place, not copied: the page loads only the vendor)
  const core = JSON.parse(byPath("sdk/funding/MANIFEST.json").bytes.toString("utf8"));
  const coreVerified = {};
  for (const [name, sha] of Object.entries(core.files ?? {})) {
    if (!/^[\w.-]+\.mjs$/.test(name)) throw new Error("sdk/funding/MANIFEST.json names an unexpected file: " + name);
    coreVerified[name] = take(CAND, "sdk/funding/" + name, sha).sha;
  }
  if (Object.keys(coreVerified).length !== 8) throw new Error("sdk/funding/MANIFEST.json must list the 8 tested core files");
  const c = take(SRC, CONFIG.path, CONFIG.sha256);
  const text = c.bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(c.bytes)) throw new Error(CONFIG.path + ": not UTF-8");
  const patched = L.applyExact(CONFIG.path, text, CONFIG_PATCH);
  L.checkNullExports(patched.text);
  files.push({ path: CONFIG.path, kind: "patched", from: c.from, originalSha256: c.sha, bytes: Buffer.from(patched.text, "utf8"),
    patch: patched.records, reverseEqual: patched.reverseEqual });
  if (files.length !== 33 || new Set(files.map((f) => f.path)).size !== 33) throw new Error("overlay must be exactly the 33 pinned paths");

  // ---- 2. write a fresh tree ----
  fs.mkdirSync(OUT);                                     // EEXIST = refused
  for (const f of files) {
    const abs = path.join(OUT, ...f.path.split("/"));
    if (!inside(OUT, abs)) throw new Error("overlay path escapes: " + f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.bytes, { flag: "wx" });
  }

  // ---- 3. verify outputs, and that every original is unchanged ----
  for (const f of files) {
    f.outputSha256 = L.sha256(L.readRegular(path.join(OUT, ...f.path.split("/"))));
    if (f.outputSha256 !== L.sha256(f.bytes)) throw new Error("overlay write mismatch: " + f.path);
    if (f.kind !== "patched" && f.outputSha256 !== f.originalSha256) throw new Error("copied file differs from its original: " + f.path);
    if (L.sha256(L.readRegular(f.from)) !== f.originalSha256) throw new Error("original changed during overlay: " + f.from);
  }
  const manifest = {
    schema: OVERLAY_SCHEMA, version: L.VERSION, source: SRC, candidate: CAND,
    notCopied: "everything else (no package.json, node_modules, other pages, scripts or sdk sources)",
    files: files.map(({ bytes, ...f }) => f).sort((a, b) => a.path.localeCompare(b.path)),
    candidateCoreVerifiedInPlace: coreVerified,
  };
  fs.writeFileSync(path.join(OUT, "OVERLAY-MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return { out: OUT, manifest };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({ options: { out: { type: "string" }, source: { type: "string" }, candidate: { type: "string" } } });
  try {
    const r = makeOverlay({ out: v.out, source: v.source, candidate: v.candidate });
    for (const f of r.manifest.files) console.log(`  ${f.outputSha256}  ${f.kind.padEnd(9)}  ${f.path}`);
    console.log(`[funding-cutover-overlay] ${r.manifest.files.length} files -> ${r.out}`);
  } catch (e) { console.error("[funding-cutover-overlay] REFUSED: " + (e?.message ?? e)); process.exit(1); }
}
