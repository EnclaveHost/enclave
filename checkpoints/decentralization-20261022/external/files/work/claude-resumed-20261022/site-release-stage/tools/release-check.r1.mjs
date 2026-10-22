#!/usr/bin/env node
// release-check.mjs <release dir> <stage src> <base dir> <out dir>   (READ-ONLY; after `prepare`, before any mirror/publish)
// Adapted from work/site-host-recovery-release/frontend-closure.mjs + delta-check.mjs. Every location is an argument: the
// credit-vault manifest and the credit/recover configs come from the STAGE SOURCE, the asset list goes to <out dir>.
//   1. pages and pins: required pages; credit-config (leaseGasReserve null, pinned origin/rpId) and recover-config are the
//      staged bytes; vendor/credit-vault.js is its manifest's bundle.
//   2. local reference closure of every built .html/.js/.css (absolute local paths and relative ES imports resolve).
//   3. features in the built bytes (the recovery release's list) + the accepted media fallback + MANDATORY platform
//      moderation (catalog-policy) + the dashboard wording fix (old wording only in retained chunks).
//   4. retention: every base js/chunks file is in the release byte-identical; the release ledger's CSP hashes include every
//      base hash; the live page set's chunks ride inside the base (coverage.mjs proved live ⊆ base).
//   5. origins: every absolute https origin named by a CURRENT built file is named in the staged sources or in the base
//      release's built files (bundled-library URLs already shipped); anything else fails: no new remote origin.
//   6. the footer build stamp is the honest dirty published-main stamp `7752a423*`.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const [REL, SRC, BASE, OUT] = process.argv.slice(2).map((p) => path.resolve(p));
const SITE = path.join(REL, "site"), BSITE = fs.existsSync(path.join(BASE, "site")) ? path.join(BASE, "site") : BASE;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const has = (rel) => { try { return fs.statSync(path.join(SITE, rel)).isFile(); } catch { return false; } };
const read = (rel) => fs.readFileSync(path.join(SITE, rel));
const fail = [], need = (c, w) => { if (!c) fail.push(w); };
const m = JSON.parse(fs.readFileSync(path.join(REL, "release.json"), "utf8"));
const kept = new Set(m.retention.kept.map((k) => k.path));
const files = m.files.map((f) => f.path);
const current = files.filter((p) => !kept.has(p) && !kept.has(p.replace(/\.map$/, "")));

// 1. pages and pins
for (const f of ["index.html", "dashboard.html", "apps.html", "apps/index.html", "apps/publish.html", "authorize.html", "sso/authorize.html",
  "sessions.html", "grant.html", "404.html", "_redirects", "js/boot.js", "credit/index.html", "credit/credit.js", "credit/credit-config.json",
  "recover/index.html", "recover/recover.js", "recover/recover-config.json", "vendor/credit-vault.js", "assets/logo.svg", "assets/icon.svg",
  "favicon.ico", ".well-known/enclave-site-release.json"]) need(has(f), `missing ${f}`);
for (const f of ["credit/credit-config.json", "recover/recover-config.json"])
  if (has(f)) need(read(f).equals(fs.readFileSync(path.join(SRC, "site", f))), `${f} is not the staged source's bytes`);
if (has("credit/credit-config.json")) {
  const c = JSON.parse(read("credit/credit-config.json"));
  need(c.leaseGasReserve === null, "credit-config leaseGasReserve is not null");
  need(c.origin === "https://enclave.host" && c.rpId === "enclave.host", "credit-config origin/rpId are not the pinned passkey origin");
}
const vm = JSON.parse(fs.readFileSync(path.join(SRC, "site/vendor/credit-vault.MANIFEST.json"), "utf8"));
if (has("vendor/credit-vault.js")) need(sha(read("vendor/credit-vault.js")) === vm.sha256, "vendor/credit-vault.js is not its manifest's bundle");

// 2. local reference closure (as frontend-closure.mjs)
const EXT = "js|mjs|css|svg|png|jpg|jpeg|webp|mp4|webm|json|ico|woff2?|wasm|html|txt|xml|webmanifest";
const ABS = new RegExp(`["'(=\\s](\\/(?:[A-Za-z0-9_.-]+\\/)*[A-Za-z0-9_.-]+\\.(?:${EXT}))(?=["'?#)\\s])`, "g");
const RELIMP = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.{1,2}\/[^"'?#]+)["']/g;
const missing = new Map(); let refs = 0;
for (const f of files.filter((x) => /\.(html|js|mjs|css)$/.test(x))) {
  const text = read(f).toString("utf8");
  for (const x of text.matchAll(ABS)) { const p = x[1].slice(1); if (p.startsWith("/")) continue; refs++; if (!has(p)) missing.set(p, f); }
  if (/\.(js|mjs)$/.test(f)) for (const x of text.matchAll(RELIMP)) { const p = path.posix.normalize(path.posix.join(path.posix.dirname(f), x[1])); refs++; if (!has(p)) missing.set(p, f); }
}
for (const [p, from] of missing) fail.push(`unresolved local reference /${p} (named in ${from})`);

// 3. features
const cur = (re) => current.filter((f) => /\.(js|html)$/.test(f)).some((f) => (typeof re === "string" ? read(f).includes(re) : re.test(read(f).toString("utf8"))));
for (const [what, needle] of [["private-app session hand-off", "/__enclave/session"], ["private-app sign-in", "private app sign-in"],
  ["app-zone certificate UI", "App address certificate"], ["history cold-start sources UI", "History sources for cold starts"],
  ["credit page", "Your Enclave credit, directly on chain"], ["passkey recovery page", "recover-config.json"],
  ["accepted media fallback (04836638)", "[data-media-cid]"], ["media fallback gateway", "https://dweb.link/ipfs/"],
  ["platform moderation: delisted", "This app is delisted or its catalog status is unavailable."],
  ["platform moderation: rejected", "This version was rejected by the catalog owner."]]) need(cur(needle), `not in the CURRENT build: ${what}`);
const OLD = " - retrying automatically";
need(!current.some((f) => read(f).includes(OLD)), "a current file carries the old dashboard wording");
need(cur(/fleet: '\+[A-Za-z_$]+\([A-Za-z_$]+\.reason\)\+"<\/span>"/), "no current chunk carries the fixed fleet-reason wording");

// 4. retention of the base (and so of the live page set)
let baseChunks = 0;
for (const e of fs.readdirSync(path.join(BSITE, "js/chunks"), { recursive: true, withFileTypes: true })) {
  if (!e.isFile()) continue;
  const p = path.relative(BSITE, path.join(e.parentPath ?? e.path, e.name)); baseChunks++;
  need(has(p) && read(p).equals(fs.readFileSync(path.join(BSITE, p))), `base chunk ${p} not retained byte-identical`);
}
const ledger = JSON.parse(read(".well-known/enclave-site-release.json"));
const lh = new Set(ledger.csp.hashes.map((h) => h.hash));
const { parseScriptSrc } = await import(path.join(SRC, "scripts/site-release/release.mjs"));
const bh = parseScriptSrc(fs.readFileSync(path.join(BSITE, "csp-script-src.txt"), "utf8")).hashes;
need(bh.every((h) => lh.has(h)), "the release CSP drops a base inline-script hash");

// 5. no new remote origin
const ORIG = /https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const srcOrigins = new Set();
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) { if (e.name !== "dist") walk(p); } else if (/\.(js|mjs|html|json|css)$/.test(e.name)) for (const x of fs.readFileSync(p, "utf8").matchAll(ORIG)) srcOrigins.add(x[0]); } })(path.join(SRC, "site"));
(function walkB(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) walkB(p); else if (/\.(js|html|css)$/.test(e.name)) for (const x of fs.readFileSync(p, "utf8").matchAll(ORIG)) srcOrigins.add(x[0]); } })(BSITE);
const newOrigins = new Set();
for (const f of current.filter((x) => /\.(js|html|css)$/.test(x))) for (const x of read(f).toString("utf8").matchAll(ORIG)) if (!srcOrigins.has(x[0])) newOrigins.add(x[0]);
need(!newOrigins.size, `new remote origins in the current build: ${[...newOrigins].sort().join(", ")}`);

// 6. stamp
const stamp = /<span data-build>([^<]*)<\/span>/.exec(read("index.html").toString("utf8"))?.[1] || "";
need(/^7752a423\* · \d{4}-\d{2}-\d{2}$/.test(stamp), `footer stamp ${JSON.stringify(stamp)} is not 7752a423* · <date>`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "asset-paths.txt"), files.filter((f) => f.startsWith("assets/")).map((a) => "/" + a).join("\n") + "\n");
const report = { cid: m.cid, files: files.length, current: current.length, retained: kept.size, localRefsChecked: refs, baseChunks, stamp,
  originsNotInSources: [...newOrigins].sort(), failures: fail.filter(Boolean) };
fs.writeFileSync(path.join(OUT, "release-check.json"), JSON.stringify(report, null, 1) + "\n");
console.log(JSON.stringify(report, null, 1));
if (report.failures.length) { console.error("RELEASE-CHECK-FAILED"); process.exit(1); }
console.log("RELEASE-CHECK-OK");
