#!/usr/bin/env node
// Frontend build closure of ONE prepared site release (the tree inside <release dir>/site), read-only.
//   node frontend-closure.mjs <release dir>
// 1. Required pages and pins:
//      dashboard/apps/authorize/sso;
//      /credit/ (index.html, credit.js, credit-config.json with leaseGasReserve null and the pinned origin/rpId);
//      /recover/;
//      the credit vendor bundle at its manifest hash.
// 2. Local reference closure: every local asset path (by file extension) named in a built .html/.js/.css must exist.
//    So must every relative ES-module import/dynamic import of a built .js file.
// 3. Features present in the built bytes: private-app browser access, app-zone/history UI, credit, recovery.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const REL = path.resolve(process.argv[2] || "");
const SITE = path.join(REL, "site");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const has = (rel) => { try { return fs.statSync(path.join(SITE, rel)).isFile(); } catch { return false; } };
const fail = [];
const need = (cond, what) => { if (!cond) fail.push(what); };

// 1. required pages and pins
for (const f of ["index.html", "dashboard.html", "apps.html", "apps/index.html", "apps/publish.html", "authorize.html", "sso/authorize.html",
  "sessions.html", "grant.html", "404.html", "_redirects", "js/boot.js", "credit/index.html", "credit/credit.js", "credit/credit-config.json",
  "recover/index.html", "recover/recover.js", "recover/recover-config.json", "vendor/credit-vault.js", "assets/logo.svg", "assets/icon.svg",
  "favicon.ico", ".well-known/enclave-site-release.json"]) need(has(f), `missing ${f}`);
if (has("credit/credit-config.json")) {
  const c = JSON.parse(fs.readFileSync(path.join(SITE, "credit/credit-config.json"), "utf8"));
  need(c.leaseGasReserve === null, "credit-config leaseGasReserve is not null (the optional parallel reserve must stay OFF)");
  need(c.origin === "https://enclave.host" && c.rpId === "enclave.host", "credit-config origin/rpId are not the pinned passkey origin");
}
const manifest = JSON.parse(fs.readFileSync(path.join(REL, "../../tree/site/vendor/credit-vault.MANIFEST.json"), "utf8"));
if (has("vendor/credit-vault.js")) need(sha(fs.readFileSync(path.join(SITE, "vendor/credit-vault.js"))) === manifest.sha256, "vendor/credit-vault.js is not the manifest's bundle");

// 2. local reference closure
const files = [];
(function walk(rel) {
  for (const e of fs.readdirSync(path.join(SITE, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(r); else files.push(r);
  }
})("");
const EXT = "js|mjs|css|svg|png|jpg|jpeg|webp|mp4|webm|json|ico|woff2?|wasm|html|txt|xml|webmanifest";
const ABS = new RegExp(`["'(=\\s](\\/(?:[A-Za-z0-9_.-]+\\/)*[A-Za-z0-9_.-]+\\.(?:${EXT}))(?=["'?#)\\s])`, "g");
const RELIMP = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.{1,2}\/[^"'?#]+)["']/g;
const missing = new Map();
let refs = 0;
for (const f of files.filter((x) => /\.(html|js|mjs|css)$/.test(x))) {
  const text = fs.readFileSync(path.join(SITE, f), "utf8");
  for (const m of text.matchAll(ABS)) {
    const p = m[1].slice(1);
    if (p.startsWith("/")) continue;                       // protocol-relative //host/...
    refs++;
    if (!has(p)) missing.set(p, f);
  }
  if (/\.(js|mjs)$/.test(f)) for (const m of text.matchAll(RELIMP)) {
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
    refs++;
    if (!has(p)) missing.set(p, f);
  }
}
for (const [p, from] of missing) fail.push(`unresolved local reference /${p} (named in ${from})`);

// 3. features present in the built bytes
const grepAny = (needle, filter = (f) => /\.(js|html)$/.test(f)) => files.filter(filter).some((f) => fs.readFileSync(path.join(SITE, f), "utf8").includes(needle));
for (const [what, needle] of [
  ["private-app session hand-off", "/__enclave/session"], ["private-app sign-in frontends control", "private app sign-in"],
  ["app-zone certificate UI", "App address certificate"], ["history cold-start sources UI", "History sources for cold starts"],
  ["credit page", "Your Enclave credit, directly on chain"], ["passkey recovery page", "recover-config.json"]]) need(grepAny(needle), `feature not found in the build: ${what}`);

const assets = files.filter((f) => f.startsWith("assets/"));
console.log(JSON.stringify({ release: path.basename(REL), files: files.length, localRefsChecked: refs, assets: assets.length, failures: fail }, null, 1));
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "logs/asset-paths.txt"), assets.map((a) => "/" + a).join("\n") + "\n");
if (fail.length) { console.error("FRONTEND-CLOSURE-FAILED"); process.exit(1); }
console.log("FRONTEND-CLOSURE-OK");
