#!/usr/bin/env node
// r4-custody-composed (work/custody-v2-site-release-r2-20261023): r3-custody (release-check.r3.mjs beside this file) with the media
// fallback (04836638) and the verified config read (r4 bad58bd8) REQUIRED again, exactly as the 10-22 stage's r2 required them
// (markers + the config reader's dynamic imports resolving to current ipfs-car / storage-plan chunks with their exports).
// r3-custody (work/custody-v2-site-release-20261023): the stage's r2 checker (sha256 98baac2b…, kept beside this file) with:
//   - the expected source commit/dirty flag from EXPECT_COMMIT / EXPECT_DIRTY ("1"|"0"), not 7752a423*;
//   - the media fallback (04836638) and verified config read (r4 bad58bd8) REPORTED as present/absent, not required: they are
//     not in this source line (custody-v2-dashboard e24a47fb2 on ff13ebe08) and not in the live base either;
//   - custody v2 panel checks: vendor/custody-v2.js == its manifest and the source bundle, the panel and its exact wording in a
//     current chunk, the vendor loaded at runtime (not inlined) and resolvable from the chunk, no default vault in page code;
//   - the reviewed wallet route's refusal strings present in current chunks.
// release-check.mjs <release dir> <stage src> <base dir> <out dir> [--dist <built dist>]   (READ-ONLY; after `prepare`, before any
// mirror/publish). <built dist> defaults to <stage src>/site/dist, the exact build output `prepare --dist` copied.
// Adapted from work/site-host-recovery-release/frontend-closure.mjs + delta-check.mjs. Every location is an argument.
// r2 (r1 = release-check.r1.mjs): r1 called a file "current" unless release.json retention.kept named it. kept lists only the
// ledger entries dated before the build, and a base WITHOUT a ledger has every inherited chunk dated to the build itself
// (release.mjs openBase), so kept was [] and r1 checked all 884 files - inherited base chunks included - as current. r2 derives
// the partition from the bytes alone and checks each part on its own terms:
//   current    = exactly the files of <built dist>; each must be in the release tree byte-identical.
//   metadata   = exactly what prepare adds: get/{install.sh,install.ps1,host.ps1} (== <stage src>/cli/<name> == installers/<name>,
//                named by the ledger) and the ledger .well-known/enclave-site-release.json (source, previous, builtAt, retained
//                set and CSP union checked against the build and the base). <built dist> may carry none of these paths.
//   inherited  = every other release file: must be a base js/chunks/** file, byte-identical, and in the ledger's retained set.
//   0. release.json names exactly the tree's files with their sha256 (independent of `cli verify`).
//   1. pages and pins: required pages; credit-config (leaseGasReserve null, pinned origin/rpId) and recover-config are the
//      staged bytes; vendor/credit-vault.js is its manifest's bundle.
//   2. local reference closure of every .html/.js/.css in the release (absolute local paths and relative ES imports resolve).
//   3. features in the CURRENT files (the recovery release's list) + the accepted media fallback + MANDATORY platform
//      moderation (catalog-policy) + the verified config read (r4 bad58bd8: CAR accept header, dag-scope=all CAR URL, the
//      round deadline) whose dynamic import("./ipfs-car-*.js") / import("./storage-plan-*.js") resolve to CURRENT chunks that
//      export verifyCar+carCap / boundedBytes + the dashboard wording fix: the old wording in NO current file (inherited
//      files carrying it are listed, not failed: they are the base's own bytes, kept for cached tabs).
//   4. retention (unchanged from r1): every base js/chunks file is in the release byte-identical; the release ledger's CSP
//      hashes include every base hash.
//   5. origins: every absolute https origin named by a CURRENT file is named in the staged sources or in the base release's
//      built files (bundled-library URLs already shipped); anything else fails: no new remote origin.
//   6. the footer build stamp is the honest dirty published-main stamp `7752a423*`.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const argv = process.argv.slice(2), di = argv.indexOf("--dist");
const DIST_ARG = di >= 0 ? argv.splice(di, 2)[1] : null;
const [REL, SRC, BASE, OUT] = argv.map((p) => path.resolve(p));
const DIST = path.resolve(DIST_ARG ?? path.join(SRC, "site/dist"));
const SITE = path.join(REL, "site"), BSITE = fs.existsSync(path.join(BASE, "site")) ? path.join(BASE, "site") : BASE;
const { LEDGER_PATH, validateLedger, openBase, parseScriptSrc } = await import(path.join(SRC, "scripts/site-release/release.mjs"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const has = (rel) => { try { return fs.statSync(path.join(SITE, rel)).isFile(); } catch { return false; } };
const read = (rel) => fs.readFileSync(path.join(SITE, rel));
const cread = (rel) => fs.readFileSync(path.join(DIST, rel));     // a CURRENT file's built bytes (== the release's, checked below)
const fail = [], need = (c, w) => { if (!c) fail.push(w); };
const listFiles = (root) => { const out = [];
  (function walk(d, r) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const rel = r ? r + "/" + e.name : e.name;
    if (e.isDirectory()) walk(path.join(d, e.name), rel); else if (e.isFile()) out.push(rel); else fail.push(`not a regular file: ${path.join(d, e.name)}`); } })(root, "");
  return out.sort(); };
const m = JSON.parse(fs.readFileSync(path.join(REL, "release.json"), "utf8"));
const files = listFiles(SITE), fileSet = new Set(files);

// 0. release.json names exactly the tree
const named = new Map(m.files.map((f) => [f.path, f.sha256]));
need(named.size === files.length && files.every((p) => named.has(p)), `release.json names ${named.size} files, the tree holds ${files.length}`);
for (const p of files) if (named.has(p)) need(named.get(p) === sha(read(p)), `release.json sha256 of ${p} is not the tree's`);

// partition: current (the built dist), prepare metadata, inherited
const INSTALLERS = ["install.sh", "install.ps1", "host.ps1"], META = new Set([LEDGER_PATH, ...INSTALLERS.map((n) => "get/" + n)]);
const current = listFiles(DIST), curSet = new Set(current);
for (const p of current) {
  if (META.has(p)) { fail.push(`the build carries ${p}, which only prepare may add`); continue; }
  need(has(p) && read(p).equals(fs.readFileSync(path.join(DIST, p))), `current built file ${p} is not in the release byte-identical`);
}
for (const p of META) need(fileSet.has(p), `prepare metadata ${p} is missing`);
for (const n of INSTALLERS) if (has("get/" + n)) {
  const b = read("get/" + n);
  need(b.equals(fs.readFileSync(path.join(SRC, "cli", n))), `get/${n} is not the staged cli/${n}`);
  need(fs.existsSync(path.join(REL, "installers", n)) && b.equals(fs.readFileSync(path.join(REL, "installers", n))), `installers/${n} is not get/${n}`);
}
const inherited = files.filter((p) => !curSet.has(p) && !META.has(p));
const baseChunks = listFiles(path.join(BSITE, "js/chunks")).map((p) => "js/chunks/" + p), baseSet = new Set(baseChunks);
for (const p of inherited)
  need(baseSet.has(p) && read(p).equals(fs.readFileSync(path.join(BSITE, p))), `release file ${p} is neither built, prepare metadata, nor a base chunk byte-identical`);

// the ledger prepare wrote, against the build, the base and release.json
const ledger = validateLedger(JSON.parse(read(LEDGER_PATH)));
const base = openBase(BASE, { builtAt: null, now: Date.parse(ledger.builtAt) });
need(ledger.builtAt === m.createdAt, "ledger builtAt is not release.json createdAt");
const EXPECT_COMMIT = process.env.EXPECT_COMMIT, EXPECT_DIRTY = process.env.EXPECT_DIRTY === "1";
need(/^[0-9a-f]{8}$/.test(EXPECT_COMMIT || ""), "EXPECT_COMMIT (8 hex) is required");
need(ledger.source.commit === EXPECT_COMMIT && ledger.source.dirty === EXPECT_DIRTY, `ledger source ${JSON.stringify(ledger.source)} is not ${EXPECT_COMMIT}${EXPECT_DIRTY ? " dirty" : " clean"}`);
need(base.cid !== null && ledger.previous === base.cid && m.base === base.cid, `ledger previous ${ledger.previous} / release.json base ${m.base} is not the base ${base.cid}`);
need(JSON.stringify([...ledger.installers].sort()) === JSON.stringify(INSTALLERS.map((n) => "get/" + n).sort()), "ledger installers are not the three get/ installers");
const releaseChunks = files.filter((p) => p.startsWith("js/chunks/")), retained = new Map(ledger.retained.map((x) => [x.path, x.lastBuiltAt]));
need(retained.size === releaseChunks.length && releaseChunks.every((p) => retained.has(p)), `ledger retains ${retained.size} paths, the release holds ${releaseChunks.length} js/chunks files`);
for (const p of current.filter((x) => x.startsWith("js/chunks/"))) need(retained.get(p) === ledger.builtAt, `current chunk ${p} is not dated to this build in the ledger`);
for (const p of inherited) need(Date.parse(retained.get(p)) === base.lastBuiltAt(p), `inherited ${p} is not dated as the base dates it`);
const own = parseScriptSrc(fs.readFileSync(path.join(DIST, "csp-script-src.txt"), "utf8"));
const lh = new Set(ledger.csp.hashes.map((h) => h.hash)), union = new Set([...own.hashes, ...base.hashes.map((h) => h.hash)]);
need(ledger.csp.scriptSrcBase === own.base, "ledger scriptSrcBase is not the build's");
need(lh.size === union.size && [...union].every((h) => lh.has(h)), "ledger CSP hashes are not exactly the build's plus the base's");

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
const relTarget = (from, spec) => path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
const missing = new Map(); let refs = 0;
for (const f of files.filter((x) => /\.(html|js|mjs|css)$/.test(x))) {
  const text = read(f).toString("utf8");
  for (const x of text.matchAll(ABS)) { const p = x[1].slice(1); if (p.startsWith("/")) continue; refs++; if (!has(p)) missing.set(p, f); }
  if (/\.(js|mjs)$/.test(f)) for (const x of text.matchAll(RELIMP)) { const p = relTarget(f, x[1]); refs++; if (!has(p)) missing.set(p, f); }
}
for (const [p, from] of missing) fail.push(`unresolved local reference /${p} (named in ${from})`);

// 3. features, in the CURRENT files' built bytes only
const curCode = current.filter((f) => /\.(js|html)$/.test(f));
const curWith = (needle) => curCode.filter((f) => (typeof needle === "string" ? cread(f).includes(needle) : needle.test(cread(f).toString("utf8"))));
const cur = (needle) => curWith(needle).length > 0;
for (const [what, needle] of [["private-app session hand-off", "/__enclave/session"], ["private-app sign-in", "private app sign-in"],
  ["app-zone certificate UI", "App address certificate"], ["history cold-start sources UI", "History sources for cold starts"],
  ["credit page", "Your Enclave credit, directly on chain"], ["passkey recovery page", "recover-config.json"],
  ["platform moderation: delisted", "This app is delisted or its catalog status is unavailable."],
  ["platform moderation: rejected", "This version was rejected by the catalog owner."],
  ["accepted media fallback (04836638)", "[data-media-cid]"], ["media fallback gateway", "https://dweb.link/ipfs/"],
  ["verified config read: CAR accept header", "application/vnd.ipld.car"], ["verified config read: whole-DAG CAR request", "?format=car&dag-scope=all"],
  ["verified config read: round deadline", "config read deadline passed"],
  // the reviewed wallet route (dc2e5d74 / 6ab298f19; test/site-built-wallet-route.test.mjs locates its chunks by these)
  ["wallet route: profile send refusal", "none of the network profile's RPC endpoints could check this transaction"],
  ["wallet route: profile receipt wait", "never relayed it"], ["wallet route: sign-only path", "eth_signTransaction"],
  // custody v2 panel (site/js/core/custody-v2.js, deployments.js)
  ["custody v2 panel controls", "es-c2-save"], ["custody v2: single-seat wording", "SINGLE-SEAT BOOTSTRAP: n = 1 seat ("],
  ["custody v2: unset state", "names no "], ["custody v2: SessionVault factory gate", "sessionVaultFactory book entry is required first"],
  ["custody v2: vendor path", "../../vendor/custody-v2.js"]]) need(cur(needle), `not in the CURRENT build: ${what}`);
const notInLine = Object.fromEntries([["media fallback (04836638)", "[data-media-cid]"], ["verified config read (r4 bad58bd8)", "config read deadline passed"]]
  .map(([w, n]) => [w, cur(n)]));
// custody v2: the vendor bundle, as shipped
const c2m = JSON.parse(fs.readFileSync(path.join(SRC, "site/vendor/custody-v2.MANIFEST.json"), "utf8"));
need(has("vendor/custody-v2.js") && sha(read("vendor/custody-v2.js")) === c2m.sha256 && read("vendor/custody-v2.js").equals(fs.readFileSync(path.join(SRC, "site/vendor/custody-v2.js"))),
  "vendor/custody-v2.js is not its manifest's bundle / the source bundle");
const c2chunks = curWith("es-c2-save").filter((f) => f.endsWith(".js"));
for (const f of c2chunks) {
  need(has(path.posix.normalize(path.posix.join(path.posix.dirname(f), "../../vendor/custody-v2.js"))), `${f}: ../../vendor/custody-v2.js does not resolve in the release`);
  need(!cread(f).includes("enclave-custody-v2 key"), `${f} inlines the custody v2 crypto (it must load /vendor/custody-v2.js at runtime)`);
  need(!/0xe48699b8401564aace7a814ae4569b67a3f7eef5/i.test(cread(f).toString("utf8")), `${f} names the production vault: page code must take it from the book only`);
}
need(c2chunks.length >= 1, "no current chunk carries the custody v2 panel");
// the config reader's dynamic imports resolve to CURRENT chunks with the exports it calls
const exportsOf = (p) => new Set([...cread(p).toString("utf8").matchAll(/export\s*\{([^}]*)\}/g)].flatMap((x) => x[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop())));
const configRead = { readers: curWith("config read deadline passed"), car: [], storagePlan: [] };
for (const f of configRead.readers) for (const x of cread(f).toString("utf8").matchAll(/\bimport\s*\(\s*["'](\.{1,2}\/[^"'?#]+)["']\s*\)/g)) {
  const p = relTarget(f, x[1]);
  if (/(^|\/)ipfs-car-[A-Za-z0-9]+\.js$/.test(p)) configRead.car.push(p);
  if (/(^|\/)storage-plan-[A-Za-z0-9]+\.js$/.test(p)) configRead.storagePlan.push(p);
}
need(configRead.car.length > 0, "the config reader has no dynamic import of an ipfs-car chunk");
need(configRead.storagePlan.length > 0, "the config reader has no dynamic import of a storage-plan chunk");
for (const p of configRead.car) need(curSet.has(p) && has(p) && ["verifyCar", "carCap"].every((e) => exportsOf(p).has(e)) && cread(p).includes("truncated varint"),
  `config reader imports ${p}, which is not a current chunk exporting verifyCar/carCap`);
for (const p of configRead.storagePlan) need(curSet.has(p) && has(p) && exportsOf(p).has("boundedBytes"), `config reader imports ${p}, which is not a current chunk exporting boundedBytes`);
const OLD = " - retrying automatically";
const oldCurrent = current.filter((f) => cread(f).includes(OLD));
for (const f of oldCurrent) fail.push(`a current file carries the old dashboard wording: ${f}`);
const oldInherited = inherited.filter((f) => read(f).includes(OLD));
need(cur(/fleet: '\+[A-Za-z_$]+\([A-Za-z_$]+\.reason\)\+"<\/span>"/), "no current chunk carries the fixed fleet-reason wording");

// 4. retention of the base (and so of the live page set) - unchanged from r1
for (const p of baseChunks) need(has(p) && read(p).equals(fs.readFileSync(path.join(BSITE, p))), `base chunk ${p} not retained byte-identical`);
const bh = parseScriptSrc(fs.readFileSync(path.join(BSITE, "csp-script-src.txt"), "utf8")).hashes;
need(bh.every((h) => lh.has(h)), "the release CSP drops a base inline-script hash");

// 5. no new remote origin
const ORIG = /https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const srcOrigins = new Set();
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) { if (p !== DIST && e.name !== "dist") walk(p); } else if (/\.(js|mjs|html|json|css)$/.test(e.name)) for (const x of fs.readFileSync(p, "utf8").matchAll(ORIG)) srcOrigins.add(x[0]); } })(path.join(SRC, "site"));
(function walkB(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) walkB(p); else if (/\.(js|html|css)$/.test(e.name)) for (const x of fs.readFileSync(p, "utf8").matchAll(ORIG)) srcOrigins.add(x[0]); } })(BSITE);
const newOrigins = new Set();
for (const f of current.filter((x) => /\.(js|html|css)$/.test(x))) for (const x of cread(f).toString("utf8").matchAll(ORIG)) if (!srcOrigins.has(x[0])) newOrigins.add(x[0]);
need(!newOrigins.size, `new remote origins in the current build: ${[...newOrigins].sort().join(", ")}`);

// 6. stamp
const stamp = /<span data-build>([^<]*)<\/span>/.exec(read("index.html").toString("utf8"))?.[1] || "";
need(new RegExp("^" + EXPECT_COMMIT + (EXPECT_DIRTY ? "\\*" : "") + " · \\d{4}-\\d{2}-\\d{2}$").test(stamp), `footer stamp ${JSON.stringify(stamp)} is not ${EXPECT_COMMIT}${EXPECT_DIRTY ? "*" : ""} · <date>`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "asset-paths.txt"), files.filter((f) => f.startsWith("assets/")).map((a) => "/" + a).join("\n") + "\n");
const rebuilt = baseChunks.filter((p) => curSet.has(p));
const report = { checker: "release-check r4-custody-composed", notInThisSourceLine: notInLine, custodyV2Chunks: c2chunks, custodyV2Vendor: c2m.sha256, cid: m.cid, dist: DIST, files: files.length,
  partition: { current: current.length, prepareMetadata: [...META].sort(), inherited: inherited.length },
  baseChunks: { total: baseChunks.length, rebuiltByteIdentical: rebuilt.length, inherited: inherited.filter((p) => baseSet.has(p)).length },
  ledger: { builtAt: ledger.builtAt, retained: retained.size, retainedUntil: new Date(Date.parse(ledger.builtAt) + ledger.retainHours * 3600e3).toISOString(),
    datedBeforeBuild: ledger.retained.filter((x) => x.lastBuiltAt !== ledger.builtAt).length, cspHashes: lh.size },
  releaseToolCounts: { retentionKept: m.retention.kept.length, countsRetainedChunks: m.counts.retainedChunks,
    meaning: "ledger entries dated before this build; a base without a ledger is dated to the build (openBase), so inherited chunks do not count here" },
  configRead: { readers: configRead.readers, car: [...new Set(configRead.car)], storagePlan: [...new Set(configRead.storagePlan)] },
  oldWording: { current: oldCurrent, inheritedOnly: oldInherited },
  localRefsChecked: refs, stamp, originsNotInSources: [...newOrigins].sort(), failures: fail.filter(Boolean) };
fs.writeFileSync(path.join(OUT, "release-check.json"), JSON.stringify(report, null, 1) + "\n");
console.log(JSON.stringify(report, null, 1));
if (report.failures.length) { console.error("RELEASE-CHECK-FAILED"); process.exit(1); }
console.log("RELEASE-CHECK-OK");
