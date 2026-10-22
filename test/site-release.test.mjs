// Site release workflow (scripts/site-release, site/deploy.sh; work/site-release-interface.txt). Everything runs in
// temporary roots, with loopback fakes for gateways, kubo RPC and the serving web server; an installed kubo is used
// OFFLINE (no daemon, no network) to cross-check CIDs and CAR import. Nothing contacts a real host.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { importDirectory, importFile, cidString } from "../scripts/site-release/unixfs.mjs";
import { writeCar, readCar } from "../scripts/site-release/car.mjs";
import { prepareRelease, verifyRelease, reviewRelease, fetchRelease, LEDGER_PATH } from "../scripts/site-release/release.mjs";
import { loadTargets, mirror, mirrorLocal, prune } from "../scripts/site-release/targets.mjs";
import { rollout, resolve } from "../scripts/site-release/rollout.mjs";
import { lockRoot } from "../scripts/site-release/root-state.mjs";
import { publicationPlan } from "../scripts/site-release/publish.mjs";
import { artifactIdentity } from "../sdk/storage/unixfs.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOTFIX = path.resolve(REPO, "../logo-site-hotfix/final");   // the production tree, when this checkout sits beside it
const PROD_CID = "bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y";
const HAVE_IPFS = spawnSync("ipfs", ["version"], { stdio: "ignore" }).status === 0;
const H = 3600e3, T0 = Date.parse("2026-10-19T00:00:00Z");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const cspHash = (s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-release-")); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (root, rel, data) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); };

// a build output shaped like scripts/build-site.mjs's: stable entries, hashed chunks, the CSP manifest, dotfiles
function makeDist(name, { chunks, scripts, boot = "boot", big = false }) {
  const d = dir(name);
  write(d, "index.html", `<html><head><script>${scripts[0]}</script></head><body><script type="module" src="js/boot.js?v=${sha(boot).slice(0, 16)}"></script></body></html>`);
  write(d, "js/boot.js", `import("./chunks/${Object.keys(chunks)[0]}");//${boot}`);
  for (const [n, body] of Object.entries(chunks)) write(d, `js/chunks/${n}`, body);
  write(d, "csp-script-src.txt", `# generated\nscript-src 'self' 'wasm-unsafe-eval' ${scripts.map(cspHash).join(" ")};\n`);
  write(d, ".well-known/security.txt", "Contact: mailto:security@example.invalid\n");
  write(d, "_redirects", "/apps /apps.html 200\n");
  if (big) write(d, "assets/big.bin", Buffer.alloc(700000, 7));   // three 256 KiB chunks: a balanced UnixFS file
  return d;
}
let installers;
const releases = {};

test("the importer reproduces kubo's CIDs (production tree and synthetic trees) and the production CAR byte for byte", { timeout: 120000 }, async (t) => {
  installers = dir("cli");
  for (const n of ["install.sh", "install.ps1", "host.ps1"]) write(installers, n, `# ${n} installer\n`);
  // file layout: the storage SDK's single-file identity is the same profile
  for (const n of [0, 1, 262144, 262145, 700000]) {
    const b = Buffer.alloc(n, 3);
    assert.equal(cidString(importFile(b).cid), artifactIdentity(new Uint8Array(b)).cid, `${n} bytes`);
  }
  const synthetic = makeDist("kubo-check", { chunks: { "a-AAAA.js": "a" }, scripts: ["x"], big: true });
  write(synthetic, "nested/deeper/empty.txt", "");
  if (HAVE_IPFS) {
    const repo = dir("ipfs-repo");
    execFileSync("ipfs", ["init", "--empty-repo", "--profile=test"], { env: { ...process.env, IPFS_PATH: repo }, stdio: "ignore" });
    const kubo = execFileSync("ipfs", ["--offline", "add", "-r", "--hidden", "--cid-version", "1", "-Q", "--only-hash", synthetic],
      { env: { ...process.env, IPFS_PATH: repo } }).toString().trim();
    assert.equal(importDirectory(synthetic).cid, kubo, "the same CID as kubo 0.42 `ipfs add -r --hidden --cid-version 1`");
  } else t.diagnostic("kubo not installed: synthetic kubo cross-check skipped");
  if (fs.existsSync(path.join(HOTFIX, "site"))) {
    const prod = importDirectory(path.join(HOTFIX, "site"));
    assert.equal(prod.cid, PROD_CID);
    const car = path.join(tmp, "prod.car");
    const w = writeCar(car, prod.cid, prod.blocks);
    assert.equal(w.sha256, JSON.parse(fs.readFileSync(path.join(HOTFIX, "manifest.json"), "utf8")).carSHA256, "the same CAR bytes production serves");
    assert.ok(prod.root.equals(fs.readFileSync(path.join(HOTFIX, "site-root.block"))));
    fs.rmSync(car);
  } else t.diagnostic("production hotfix tree not beside this checkout: production CID check skipped");
  // trees kubo would build differently are refused, never guessed
  const link = dir("with-link"); write(link, "a.txt", "a"); fs.symlinkSync("a.txt", path.join(link, "b.txt"));
  assert.throws(() => importDirectory(link), /symlink/);
  const wide = dir("wide");
  for (let i = 0; i < 3500; i++) write(wide, `chunk-${String(i).padStart(4, "0")}-${"x".repeat(30)}.js`, String(i % 7));
  assert.throws(() => importDirectory(wide), /HAMT/);
});

test("prepare: one union tree keeps cached-tab chunks and CSP hashes 48h after their last build, then drops them", { timeout: 120000 }, () => {
  const d1 = makeDist("dist1", { chunks: { "a-AAAA.js": "a1", "b-BBBB.js": "b1" }, scripts: ["one"], boot: "1" });
  assert.throws(() => prepareRelease({ dist: d1, installers, out: dir("out"), now: T0 }), /needs its base/);
  const r1 = prepareRelease({ dist: d1, installers, out: dir("out"), noBase: true, now: T0, source: { commit: "aaaa1111", dirty: false } });
  // 24h later: chunk a and inline script "one" are gone from the build, so they ride along for cached tabs
  const d2 = makeDist("dist2", { chunks: { "b-BBBB.js": "b1", "c-CCCC.js": "c2" }, scripts: ["two"], boot: "2" });
  const r2 = prepareRelease({ dist: d2, installers, out: dir("out"), base: r1.dir, now: T0 + 24 * H });
  const files2 = new Set(r2.manifest.files.map((f) => f.path));
  for (const p of ["js/chunks/a-AAAA.js", "js/chunks/b-BBBB.js", "js/chunks/c-CCCC.js", "get/install.sh", "get/host.ps1", LEDGER_PATH]) assert.ok(files2.has(p), p);
  assert.deepEqual(r2.manifest.retention.kept, [{ path: "js/chunks/a-AAAA.js", until: new Date(T0 + 48 * H).toISOString() }]);
  const csp2 = r2.manifest.headers["Content-Security-Policy"];
  assert.ok(csp2.includes(cspHash("one")) && csp2.includes(cspHash("two")), "the script-src union covers the old and the new inline script");
  assert.match(csp2, /script-src 'self' 'wasm-unsafe-eval' 'sha256-/);
  for (const k of ["Cross-Origin-Opener-Policy", "Permissions-Policy", "Referrer-Policy", "Strict-Transport-Security", "X-Content-Type-Options"]) assert.ok(r2.manifest.headers[k], k);
  assert.equal(fs.readFileSync(path.join(r2.dir, "installers", "install.ps1"), "utf8"), "# install.ps1 installer\n");
  // 49h after the first build: a's window (last built at T0) has closed; b and c are still current or recent
  const d3 = makeDist("dist3", { chunks: { "d-DDDD.js": "d3" }, scripts: ["three"], boot: "3" });
  const r3 = prepareRelease({ dist: d3, installers, out: dir("out"), base: r2.dir, now: T0 + 49 * H });
  const files3 = new Set(r3.manifest.files.map((f) => f.path));
  assert.ok(!files3.has("js/chunks/a-AAAA.js") && files3.has("js/chunks/b-BBBB.js") && files3.has("js/chunks/c-CCCC.js"));
  assert.deepEqual(r3.dropped.chunks, ["js/chunks/a-AAAA.js"]);
  assert.ok(!r3.manifest.headers["Content-Security-Policy"].includes(cspHash("one")) && r3.manifest.headers["Content-Security-Policy"].includes(cspHash("two")));
  // a hashed name with different bytes is refused (hashed names are content-addressed), and nothing is left behind
  const bad = makeDist("dist-bad", { chunks: { "c-CCCC.js": "NOT c2" }, scripts: ["x"] });
  assert.throws(() => prepareRelease({ dist: bad, installers, out: dir("out"), base: r2.dir, now: T0 + 25 * H }), /differs from the base's copy/);
  assert.deepEqual(fs.readdirSync(path.join(tmp, "out")).filter((n) => n.startsWith(".")), [], "no staging directory survives a refusal");
  // the same input twice is the same CID, reused rather than overwritten
  assert.equal(prepareRelease({ dist: d1, installers, out: dir("out"), noBase: true, now: T0, source: { commit: "aaaa1111", dirty: false } }).reused, true);
  Object.assign(releases, { r1, r2, r3 });
  assert.match(reviewRelease(r2.dir).text, new RegExp(`^site release ${r2.cid}\\n[^]*retained for cached tabs: 1 older hashed chunks[^]*--approve ${r2.cid}`));
});

test("a production-format base without a ledger keeps every old chunk and CSP hash (dated conservatively)", { timeout: 120000 }, (t) => {
  if (!fs.existsSync(path.join(HOTFIX, "site"))) return t.skip("production hotfix tree not beside this checkout");
  const d = makeDist("dist-on-prod", { chunks: { "new-NEWW.js": "n" }, scripts: ["new"] });
  const r = prepareRelease({ dist: d, installers, out: dir("out-prod"), base: HOTFIX, now: T0 });
  const prodChunks = fs.readdirSync(path.join(HOTFIX, "site/js/chunks"));
  const have = new Set(r.manifest.files.map((f) => f.path));
  assert.ok(prodChunks.every((n) => have.has("js/chunks/" + n)), `all ${prodChunks.length} production chunks are kept`);
  const prodHashes = fs.readFileSync(path.join(HOTFIX, "site/csp-script-src.txt"), "utf8").match(/'sha256-[^']+'/g);
  assert.ok(prodHashes.every((h) => r.manifest.headers["Content-Security-Policy"].includes(h)), "every production CSP hash stays in the union");
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, "site", LEDGER_PATH), "utf8")).previous, PROD_CID);
  assert.ok(r.manifest.retention.kept.every((k) => k.until === new Date(T0 + 48 * H).toISOString()), "an undated base is kept 48h from now");
  fs.rmSync(path.join(tmp, "out-prod"), { recursive: true, force: true });
});

test("verify refuses every tampering: a tree byte, a CAR block, derived headers, a stray file", { timeout: 60000 }, () => {
  const copy = (n) => { const d = path.join(dir("tamper"), releases.r2.cid + (n ? "" : "")); fs.rmSync(d, { recursive: true, force: true }); fs.cpSync(releases.r2.dir, d, { recursive: true }); return d; };
  let d = copy(); fs.appendFileSync(path.join(d, "site/js/chunks/c-CCCC.js"), "!"); assert.throws(() => verifyRelease(d), /hashes to/);
  d = copy(); const car = fs.readFileSync(path.join(d, "site.car")); car[car.length - 3] ^= 1; fs.writeFileSync(path.join(d, "site.car"), car); assert.throws(() => verifyRelease(d), /site.car differs/);
  d = copy(); fs.writeFileSync(path.join(d, "headers.caddy"), "header {\n}\n"); assert.throws(() => verifyRelease(d), /headers.caddy/);
  d = copy(); fs.writeFileSync(path.join(d, "extra"), "x"); assert.throws(() => verifyRelease(d), /exactly/);
  d = copy(); fs.writeFileSync(path.join(d, "installers/install.sh"), "evil"); assert.throws(() => verifyRelease(d), /installers/);
  // a CAR verifies on its own: a block that does not hash to its CID is refused
  const raw = fs.readFileSync(path.join(releases.r2.dir, "site.car")); const bad = Buffer.from(raw); bad[bad.length - 1] ^= 1;
  assert.throws(() => readCar(bad, { expectRoot: releases.r2.cid }), /does not hash/);
  assert.throws(() => readCar(raw, { expectRoot: releases.r1.cid }), /root is/);
});

function serve(handler) {
  return new Promise((ok) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => ok(s)); });
}
const close = (s) => new Promise((ok) => { s.closeAllConnections?.(); s.close(ok); });

test("fetch by CID from untrusted gateways rebuilds a byte-identical release; a lying gateway is refused", { timeout: 60000 }, async () => {
  const cars = { [releases.r2.cid]: fs.readFileSync(path.join(releases.r2.dir, "site.car")) };
  const liar = await serve((req, res) => { res.writeHead(200); res.end(fs.readFileSync(path.join(releases.r1.dir, "site.car"))); });
  const honest = await serve((req, res) => {
    const m = /^\/ipfs\/(b[a-z2-7]+)\?format=car$/.exec(req.url);
    if (!m || !cars[m[1]] || req.headers.accept !== "application/vnd.ipld.car") { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/vnd.ipld.car" }); res.end(cars[m[1]]);
  });
  try {
    const out = dir("fetched");
    const gws = [`http://127.0.0.1:${liar.address().port}`, `http://127.0.0.1:${honest.address().port}`];
    await assert.rejects(fetchRelease({ cid: releases.r2.cid, gateways: [gws[0]], out }), /root is/);
    const r = await fetchRelease({ cid: releases.r2.cid, gateways: gws, out });
    // fetched AS A BASE, the tree is believed by its CID, so the next release records it as `previous`
    const asBase = await fetchRelease({ cid: releases.r2.cid, gateways: gws.slice(1), out: dir("fetched-base"), asBase: true });
    assert.deepEqual(fs.readdirSync(asBase.dir), ["site"]);
    const d4 = makeDist("dist4", { chunks: { "e-EEEE.js": "e4" }, scripts: ["four"] });
    const r4 = prepareRelease({ dist: d4, installers, out: dir("out4"), base: asBase.dir, now: T0 + 30 * H });
    assert.equal(JSON.parse(fs.readFileSync(path.join(r4.dir, "site", LEDGER_PATH), "utf8")).previous, releases.r2.cid);
    assert.ok(r4.manifest.files.some((f) => f.path === "js/chunks/c-CCCC.js"), "the fetched base's ledger carried retention forward");
    const files = (root) => { const o = {}; const w = (a, rel) => { for (const e of fs.readdirSync(a, { withFileTypes: true })) { const p = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) w(path.join(a, e.name), p); else o[p] = sha(fs.readFileSync(path.join(a, e.name))); } }; w(root, ""); return o; };
    assert.deepEqual(files(r.dir), files(releases.r2.dir), "every file, release.json and headers.caddy included, is byte-identical");
    await assert.rejects(fetchRelease({ cid: releases.r2.cid, gateways: [], out }), /no default/);
  } finally { await close(liar); await close(honest); }
});

// a kubo RPC stand-in: it verifies the CAR it is given exactly as a node would before pinning
async function fakeKubo() {
  const blocks = new Map(), pins = new Set(), mode = {}, calls = [];
  const s = await serve(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks), u = new URL(req.url, "http://k"); calls.push(u.pathname);
    const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(typeof o === "string" ? o : JSON.stringify(o)); };
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    if (u.pathname === "/api/v0/dag/import") {
      const start = body.indexOf(Buffer.from("\r\n\r\n")) + 4, end = body.lastIndexOf(Buffer.from("\r\n--"));
      const car = readCar(body.subarray(start, end));
      for (const [k, v] of car.blocks) blocks.set(k, v);
      if (mode.import === "fail") { res.writeHead(500); return res.end("datastore full"); }
      pins.add(car.root);
      return json(JSON.stringify({ Root: { Cid: { "/": car.root }, PinErrorMsg: "" } }) + "\n");
    }
    if (u.pathname === "/api/v0/pin/ls") { const c = u.searchParams.get("arg"); return json(pins.has(c) ? { Keys: { [c]: { Type: "recursive" } } } : { Keys: {} }); }
    if (u.pathname === "/api/v0/block/get") { const b = blocks.get(u.searchParams.get("arg")); res.writeHead(b ? 200 : 500); return res.end(mode.block === "lie" ? Buffer.from("x") : b); }
    res.writeHead(404); res.end();
  });
  return { url: `http://127.0.0.1:${s.address().port}`, s, mode, calls, pins };
}

// a stand-in web server for one local root (unit coverage; test/site-delivery.test.mjs runs actual Caddy): it serves
// root/current/site with the headers of root/headers.caddy, read per request, so a probe checks files AND live headers
async function fakeFront(root, mode = {}) {
  const s = await serve((req, res) => {
    try {
      const cur = path.join(root, "current"), file = path.join(cur, "site", decodeURIComponent(new URL(req.url, "http://f").pathname));
      const headers = {};
      for (const m of fs.readFileSync(path.join(root, "headers.caddy"), "utf8").matchAll(/^ {4}([A-Za-z-]+) "([^"]*)"$/gm)) headers[m[1]] = m[2];
      if (mode.broken) { res.writeHead(200, headers); return res.end("stale"); }
      res.writeHead(200, headers); res.end(fs.readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
  });
  return { url: `http://127.0.0.1:${s.address().port}/`, s, mode };
}

test("mirror: every target gets the SAME verified CID; an interrupted copy never touches the live tree; partial results activate nothing", { timeout: 120000 }, async () => {
  const kubo = await fakeKubo();
  const A = dir("targets/a"), B = dir("targets/b");
  const reloads = path.join(tmp, "reloads.log");
  const reload = [process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(reloads)}, "reload\\n")`];
  const fronts = { a: await fakeFront(A), b: await fakeFront(B) };
  const targetsFile = path.join(tmp, "targets.json");
  fs.writeFileSync(targetsFile, JSON.stringify({ version: 1, targets: [
    { name: "a", kind: "local-root", root: A, activate: { reload, probe: { url: fronts.a.url, paths: ["index.html", "js/boot.js"], headers: true } } },
    { name: "b", kind: "local-root", root: B, activate: { reload, probe: { url: fronts.b.url, paths: ["index.html", "js/boot.js"], headers: true } } },
    { name: "k", kind: "kubo", api: kubo.url } ] }));
  try {
    // the file refuses anything it does not define (a secret or a host cannot ride in unnoticed)
    fs.writeFileSync(path.join(tmp, "bad-targets.json"), JSON.stringify({ version: 1, targets: [{ name: "k", kind: "kubo", api: kubo.url, token: "secret" }] }));
    assert.throws(() => loadTargets(path.join(tmp, "bad-targets.json")), /unknown keys/);
    const targets = loadTargets(targetsFile);
    // an interrupted copy (a crash after 5 files): the target holds no release and no half tree under its CID
    let n = 0;
    await assert.rejects(mirrorLocal(targets[0], releases.r1.dir, { onFile: () => { if (++n === 5) throw new Error("power cut"); } }), /power cut/);
    assert.ok(!fs.existsSync(path.join(A, releases.r1.cid)));
    // a crash that never ran its cleanup leaves only .incoming-*: the next run removes it and completes
    fs.mkdirSync(path.join(A, `.incoming-${releases.r1.cid}-dead`));
    const m1 = await mirror(targets, releases.r1.dir);
    assert.equal(m1.ok, true, JSON.stringify(m1));
    assert.deepEqual(m1.results.map((r) => [r.name, r.cid, r.state]), [["a", releases.r1.cid, "mirrored"], ["b", releases.r1.cid, "mirrored"], ["k", releases.r1.cid, "pinned"]]);
    assert.deepEqual(fs.readdirSync(A).filter((n) => n !== ".site-release.lock").sort(), [releases.r1.cid], "the kernel lock file stays; nothing else");
    // a repeat is idempotent; a DIFFERENT release.json under the same CID is refused, never overwritten
    assert.equal((await mirror(targets, releases.r1.dir)).results[0].state, "present");
    fs.appendFileSync(path.join(B, releases.r1.cid, "release.json"), " ");
    const clash = await mirror(targets, releases.r1.dir);
    assert.equal(clash.ok, false); assert.match(clash.results[1].error, /holds a different release\.json for the same CID: refusing to touch it/);
    fs.writeFileSync(path.join(B, releases.r1.cid, "release.json"), fs.readFileSync(path.join(releases.r1.dir, "release.json")));
    // a kubo node whose root block reads back wrong fails its target: the run is not ok
    kubo.mode.block = "lie";
    const lied = await mirror(targets, releases.r2.dir);
    assert.equal(lied.ok, false); assert.match(lied.results[2].error, /root block differs/);
    kubo.mode.block = undefined;
    // a held lock refuses a second concurrent run
    const release = await lockRoot(A);   // a live holder of the kernel lock (this test)
    await assert.rejects(mirrorLocal(targets[0], releases.r2.dir), /locked by another release run/);
    await release();
    assert.equal((await mirror(targets, releases.r2.dir)).ok, true);

    // ---- activation: a journalled rollout; per target headers, reload, swap, probe of the live bytes AND headers ----
    const journalDir = path.join(tmp, "journal"), go = (cid, kind) => rollout(targets, cid, { journalDir, ...(kind ? { kind } : {}) });
    const act1 = await go(releases.r1.cid);
    assert.equal(act1.status, "active"); assert.deepEqual(act1.targets.map((x) => [x.name, x.state]), [["a", "committed"], ["b", "committed"]]);
    assert.equal(fs.readlinkSync(path.join(A, "current")), releases.r1.cid);
    // the second target serves stale bytes: b's activation fails its probe, and while the server keeps serving stale bytes
    // b's rollback cannot be CONFIRMED either, so b is pending (never claimed restored). a is undone (fenced).
    fronts.b.mode.broken = true;
    const failed = await go(releases.r2.cid);
    assert.equal(failed.status, "pending"); assert.deepEqual(failed.targets.map((x) => [x.name, x.state]), [["a", "undone"], ["b", "unknown"]]);
    assert.match(failed.targets[1].detail, /could not be confirmed/);
    // the server is fixed; resolve confirms b's rollback and the rollout is reverted
    fronts.b.mode.broken = false;
    const settled = await resolve(targets, failed.journal);
    assert.equal(settled.status, "reverted"); assert.deepEqual(settled.targets.map((x) => [x.name, x.state]), [["a", "undone"], ["b", "rolled-back"]]);
    assert.equal(fs.readlinkSync(path.join(A, "current")), releases.r1.cid);
    assert.equal(fs.readlinkSync(path.join(B, "current")), releases.r1.cid);
    const act2 = await go(releases.r2.cid);
    assert.equal(act2.status, "active");
    // a tab cached on r1 keeps working on the live r2: its chunk is served with r1's bytes, its inline script's hash is
    // in the live CSP header
    const cached = await new Promise((ok, no) => http.get(fronts.a.url + "js/chunks/a-AAAA.js", (res) => { const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => ok({ status: res.statusCode, csp: res.headers["content-security-policy"], body: Buffer.concat(c).toString() })); }).on("error", no));
    assert.deepEqual([cached.status, cached.body], [200, "a1"]);
    assert.ok(cached.csp.includes(cspHash("one")) && cached.csp.includes(cspHash("two")));
    const log = fs.readFileSync(path.join(A, "releases.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(log.map((e) => [e.cid, e.previous, !!e.rollback]), [[releases.r1.cid, null, false], [releases.r2.cid, releases.r1.cid, false],
      [releases.r1.cid, releases.r2.cid, true], [releases.r2.cid, releases.r1.cid, false]]);
    assert.ok(fs.readFileSync(reloads, "utf8").trim().split("\n").length >= 6, "every swap and every rollback reloaded the server");
    // rollback is the same fenced rollout, to a release that is present and verified
    assert.equal((await go(releases.r1.cid, "rollback")).status, "active");
    assert.equal(fs.readlinkSync(path.join(B, "current")), releases.r1.cid);
    assert.equal((await go(releases.r2.cid)).status, "active");

    // ---- prune: never current or previous, never inside the 48h window, never an unrecorded release ----
    await mirror(targets, releases.r3.dir);
    assert.equal((await go(releases.r3.cid)).status, "active");   // r1 is now superseded (current r3, previous r2)
    assert.deepEqual((await prune(targets[0], { now: Date.now() + 47 * H })).removed, [], "inside 48h nothing goes");
    await assert.rejects(prune(targets[0], { keepHours: 12 }), /at least 48h/);
    assert.deepEqual((await prune(targets[0], { now: Date.now() + 49 * H })).removed, [releases.r1.cid]);
    assert.ok(fs.existsSync(path.join(A, releases.r2.cid)) && fs.existsSync(path.join(A, releases.r3.cid)));
  } finally { await close(kubo.s); await close(fronts.a.s); await close(fronts.b.s); }
});

test("publication plan: the same signing identity, only `value` changes, and no secret is ever accepted or echoed", { timeout: 60000 }, () => {
  const id = "0x" + "d9".repeat(32), out = dir("plan");
  const config = { ipnsKey: "$IPNS_ED25519_SK", value: "https://gateway.example/site-root", lifetimeSecs: 172800, republishSecs: 14400,
    delegates: ["https://delegated-ipfs.dev"], bootstrap: ["/dns/am6.bootstrap.libp2p.io/tcp/4001/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb"],
    dht: true, api_key: "$API_KEY", ipni: { indexers: ["https://cid.contact"] } };
  const shown = { id, envelope: "{}", waf: null, config, configCid: null, versionConfig: "" };
  const r = publicationPlan({ releaseDir: releases.r2.dir, shown, deployment: id, owner: "0x" + "ab".repeat(20), out });
  const next = JSON.parse(fs.readFileSync(r.configFile, "utf8"));
  assert.deepEqual(next, { ...config, value: `/ipfs/${releases.r2.cid}` }, "every other key, the key reference included, unchanged");
  assert.equal(r.plan.identity.ipnsKey, "$IPNS_ED25519_SK"); assert.deepEqual(r.plan.changedKeys, ["value"]);
  assert.match(r.plan.warnings[0], /mutable URL/);
  assert.deepEqual(r.plan.operations[0].argv, ["enclave", "config", "set", id, "--file", r.configFile]);
  assert.deepEqual(r.plan.operations[1].argv.slice(-3), ["--unsigned", "--from", "0x" + "ab".repeat(20)]);
  const literal = "9f".repeat(32);
  for (const [bad, re] of [[{ ...config, ipnsKey: literal }, /ipnsKey must be a \$NAME reference/], [{ ...config, api_key: "hunter2" }, /api_key must be/],
    [{ ...config, ipni: { secret: "A".repeat(44) } }, /key-like material at ipni.secret/]]) {
    let err;
    try { publicationPlan({ releaseDir: releases.r2.dir, shown: { ...shown, config: bad }, deployment: id, out: dir("plan-bad") }); } catch (e) { err = e; }
    assert.match(err.message, re); assert.ok(!err.message.includes(literal) && !err.message.includes("hunter2") && !err.message.includes("A".repeat(44)), "the value is never shown");
  }
  assert.throws(() => publicationPlan({ releaseDir: releases.r2.dir, shown, deployment: "0x" + "11".repeat(32), out }), /not `enclave config show` output/);
  assert.throws(() => publicationPlan({ releaseDir: releases.r2.dir, shown: { ...shown, config: next }, deployment: id, out }), /already publishes/);
  assert.throws(() => publicationPlan({ releaseDir: releases.r2.dir, shown: { ...shown, config: null }, deployment: id, out }), /no per-deployment config/);
  for (const f of fs.readdirSync(dir("plan-bad"))) assert.fail(`a refused plan wrote ${f}`);
});

test("an installed kubo, offline, imports the release CAR and reads back exactly the tree", { timeout: 120000 }, (t) => {
  if (!HAVE_IPFS) return t.skip("kubo not installed");
  const repo = path.join(tmp, "ipfs-repo"), env = { ...process.env, IPFS_PATH: repo };
  const out = execFileSync("ipfs", ["--offline", "dag", "import", "--pin-roots", path.join(releases.r2.dir, "site.car")], { env }).toString();
  assert.match(out, new RegExp(`Pinned root\\s+${releases.r2.cid}\\s+success`));
  const got = path.join(tmp, "kubo-get");
  execFileSync("ipfs", ["--offline", "get", releases.r2.cid, "-o", got], { env, stdio: "ignore" });
  for (const f of releases.r2.manifest.files) assert.equal(sha(fs.readFileSync(path.join(got, f.path))), f.sha256, f.path);
});

test("site/deploy.sh and the site job name no host, path or key; detection still ships site and installer changes", () => {
  const sh = fs.readFileSync(path.join(REPO, "site/deploy.sh"), "utf8");
  execFileSync("bash", ["-n", path.join(REPO, "site/deploy.sh")]);
  assert.doesNotMatch(sh.replace(/^#.*$/gm, ""), /\bnan\b|ssh|scp|rsync|\/opt\/|\/etc\/|caddy|curl|https?:\/\//i);
  const yml = fs.readFileSync(path.join(REPO, ".github/workflows/deploy.yml"), "utf8");
  const job = yml.slice(yml.indexOf("\n  site:\n"), yml.indexOf("\n  relay:\n"));
  // the site jobs name no host, box alias or path: every target and credential is an operator variable or secret
  assert.doesNotMatch(job, /\bnan\b|DEPLOY_SSH_KEY|SITE_SSH_HOST|~\/\.ssh|\/opt\/|\/etc\//i);
  assert.doesNotMatch(job, /Host [A-Za-z0-9-]+\\n|^\s*Host \S/m, "no ssh config stanza naming a host");
  const build = job.slice(0, job.indexOf("\n  site-deliver:\n"));
  assert.doesNotMatch(build, /secrets\./, "the build job holds no secret");
  const deliver = job.slice(job.indexOf("\n  site-deliver:\n"));
  assert.match(deliver, /environment: site-release/);
  assert.match(deliver, /needs: site\n/);
  assert.match(deliver, /gh run download "\$GITHUB_RUN_ID"[^]*cli\.mjs verify/);
  assert.match(deliver, /deliver --release "\$RUNNER_TEMP\/release\/\$CID" --targets "\$RUNNER_TEMP\/targets\.json" --approve "\$CID" \\\n\s+--journal "\$RUNNER_TEMP\/rollouts"/);
  assert.match(deliver, /5\) title="PENDING[^]*Upload the rollout journal[^]*if: always\(\)/);
  assert.deepEqual([...deliver.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]).sort(),
    ["SITE_DELIVERY_KNOWN_HOSTS", "SITE_DELIVERY_KUBO_AUTH", "SITE_DELIVERY_SSH_KEY", "SITE_PUBLISH_GAS_KEY", "SITE_PUBLISH_SESSION"]);
  assert.match(job, /bash site\/deploy\.sh prepare --out "\$RUNNER_TEMP\/site-release" \$SITE_BASE_ARGS/);
  assert.match(job, /vars\.SITE_RELEASE_BASE_CID[^]*vars\.SITE_RELEASE_GATEWAYS[^]*exit 1/);
  assert.match(job, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02[^]*include-hidden-files: true/);
  assert.match(yml, /site\/\*\)\s+site=true ;;/);
  assert.match(yml, /cli\/install\.sh\|cli\/install\.ps1\|cli\/host\.ps1\) site=true ;;/);
  assert.match(yml, /scripts\/site-release\/\*\) ;;/);
});
