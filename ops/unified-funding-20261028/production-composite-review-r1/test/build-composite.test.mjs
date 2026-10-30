// Offline tests on small synthetic trees. They use the production entry point and the same hash-pinned loader of the
// real repository's unixfs.mjs/car.mjs (they fail if those pins don't match); nothing here can switch a check off.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildComposite, loadSiteRelease, pyCanonical, MAX_TOTAL_BYTES, PROVENANCE, FAILED } from "../build-composite.mjs";

const SITE_RELEASE = "/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/scripts/site-release";
const REAL_INVENTORY = "/home/steven/Documents/Codex/2026-10-23/it/work/restore-queued-20261028/live-site-public/tree-us-west.json";
const lib = await loadSiteRelease(SITE_RELEASE);
const sha = (b) => createHash("sha256").update(b).digest("hex");

const BASE = {
  ".well-known/enclave-site-release.json": '{"schema":"enclave-site-release-ledger/1","source":{"commit":"48a812d22","dirty":true}}\n',
  "index.html": "<!doctype html><title>base</title>\n",
  "css/site.css": "body{}\n",
  "js/boot.js": "export const navigate = () => {};\n",
  "js/chunks/a.js": "export default 1;\n",
  "vendor/sessions.js": "live sessions\n",
  "assets/big.bin": Buffer.alloc(600 * 1024, 7),   // three 256 KiB UnixFS chunks
};
const EMPTY_DIRS = ["sso"];
const ADD = {
  "funding.html": "<!doctype html><title>funding</title>\n",
  "js/funding-r2/funding.0000000000000001.js": "export {};\n",
  "vendor/sessions.funding-r2.0000000000000002.js": "sessions r2\n",
  "vendor/funding.funding-r2.0000000000000003.js": "funding r2\n",
  "css/site.funding-r2.0000000000000004.css": "body{color:red}\n",
};
const withAdd = (drop, p, c) => { const a = { ...ADD }; delete a[drop]; a[p] = c; return a; };

function writeTree(root, files, emptyDirs = []) {
  fs.mkdirSync(root, { recursive: true });
  for (const d of emptyDirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); }
}
// mirrors capture-tree.py
function capture(root, cid) {
  const files = [], directories = [];
  const walk = (abs, rel) => { for (const n of fs.readdirSync(abs).sort()) {
    const a = path.join(abs, n), r = rel ? `${rel}/${n}` : n;
    if (fs.lstatSync(a).isDirectory()) { directories.push(r); walk(a, r); } else { const b = fs.readFileSync(a); files.push({ path: r, bytes: b.length, sha256: sha(b) }); }
  } };
  walk(root, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)); directories.sort();
  return { capturedAt: "2026-10-28T00:00:00+00:00", root, claimedReleaseCID: cid, filesCount: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0),
    inventorySha256: sha(Buffer.from(pyCanonical(files, directories))), directories, files };
}

function fixture(t, { base = BASE, add = ADD, emptyDirs = EMPTY_DIRS } = {}) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "composite-test-")));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const baseTree = path.join(d, "base", "site");
  writeTree(baseTree, base, emptyDirs);
  const baseCid = lib.importDirectory(baseTree).cid, inv = capture(baseTree, baseCid), inventory = path.join(d, "inventory.json");
  fs.writeFileSync(inventory, JSON.stringify(inv, null, 2) + "\n");

  const addon = path.join(d, "addon");
  writeTree(path.join(addon, "site-additions"), add);
  const additions = Object.entries(add).map(([p, c]) => ({ path: p, sha256: sha(Buffer.from(c)), bytes: Buffer.byteLength(c) }));
  const pins = { config: "a".repeat(64), existingPaths: "b".repeat(64), liveInventory: "c".repeat(64), liveSessionsVendor: "d".repeat(64) };
  const inputs = { "addon:src/entry.js": "1".repeat(64), "site/js/pages/funding.js": "2".repeat(64) };
  const manifest = Buffer.from(JSON.stringify({ schema: "enclave-funding-addon-manifest-r2", version: "funding-r2", mode: "build", esbuildVersion: "0.28.1",
    pins, inputs, moduleClosure: Object.keys(inputs), additions }, null, 2) + "\n");
  fs.writeFileSync(path.join(addon, "MANIFEST.json"), manifest);
  fs.writeFileSync(path.join(addon, "ADDITIONS.json"), JSON.stringify(additions, null, 2) + "\n");
  fs.writeFileSync(path.join(addon, "ADDITIONS.sha256"), additions.map((a) => `${a.sha256}  ${a.path}`).join("\n") + "\n");
  const addonPins = path.join(d, "pins.json");
  fs.writeFileSync(addonPins, JSON.stringify({ schema: "enclave-funding-addon-pins-r2", reviewed: true, esbuildVersion: "0.28.1", ...pins, inputs }, null, 2));

  const opts = { baseTree, inventory, addon, addonPins, out: path.join(d, "out"), siteReleaseDir: SITE_RELEASE, baseCid,
    expectFiles: inv.filesCount, expectBytes: inv.bytes, expectInventorySha256: inv.inventorySha256, expectAddonManifestSha256: sha(manifest),
    baseSourceCommit: "48a812d22", baseSourceDirty: true };
  return { d, opts, inv, baseTree, addon, inventory, addonPins };
}
async function refuses(opts, re) {
  await assert.rejects(buildComposite(opts), re);
  assert.equal(fs.existsSync(opts.out), false, "a refused run must not create out");
}
const rewriteJson = (file, fn) => { const j = JSON.parse(fs.readFileSync(file, "utf8")); fn(j); fs.writeFileSync(file, JSON.stringify(j, null, 2)); };

// ---- canonical inventory hash = capture-tree.py ----
test("pyCanonical reproduces Python json.dumps(sort_keys, compact, ensure_ascii)", () => {
  assert.equal(pyCanonical([{ path: "a", bytes: 1, sha256: "x" }], ["d"]), '{"directories":["d"],"files":[{"bytes":1,"path":"a","sha256":"x"}]}');
  assert.equal(pyCanonical([{ sha256: "y", path: "é\u007f😀\n", bytes: 0 }], []),
    '{"directories":[],"files":[{"bytes":0,"path":"\\u00e9\\u007f\\ud83d\\ude00\\n","sha256":"y"}]}');
});
test("the real captured inventory hashes to its stated canonical sha256", { skip: !fs.existsSync(REAL_INVENTORY) && "real inventory absent" }, () => {
  const inv = JSON.parse(fs.readFileSync(REAL_INVENTORY, "utf8"));
  assert.equal(sha(Buffer.from(pyCanonical(inv.files, inv.directories))), inv.inventorySha256);
  assert.equal(inv.inventorySha256, "9269fe1f19b3d4e32aa109717c8e187ddfd4300294ef1d52e52bfc65642fa372");
});

// ---- happy path: preservation + round trip ----
test("builds base + exactly five additions, preserving every old file and round-tripping the CAR", async (t) => {
  const { opts, inv, baseTree } = fixture(t);
  const r = await buildComposite(opts);
  assert.match(r.newCid, /^b[a-z2-7]{58}$/); assert.notEqual(r.newCid, opts.baseCid);
  assert.equal(r.files, inv.filesCount + 5);
  assert.ok(fs.existsSync(path.join(opts.out, PROVENANCE))); assert.ok(!fs.existsSync(path.join(opts.out, FAILED)));

  // independent re-derivation from the staged tree and from the CAR bytes
  assert.equal(lib.importDirectory(path.join(opts.out, "site")).cid, r.newCid);
  const carBytes = fs.readFileSync(path.join(opts.out, "site.car"));
  assert.equal(sha(carBytes), r.car.sha256);
  const car = lib.readCar(carBytes, { expectRoot: r.newCid }), byPath = new Map(car.files.map((f) => [f.path, f]));
  assert.deepEqual([...byPath.keys()].sort(), [...inv.files.map((f) => f.path), ...Object.keys(ADD)].sort());
  const baseFiles = new Map(lib.importDirectory(baseTree).files.map((f) => [f.path, f]));
  for (const f of inv.files) { const c = byPath.get(f.path); assert.equal(c.sha256, f.sha256); assert.equal(c.bytes, f.bytes); assert.equal(c.cid, baseFiles.get(f.path).cid); }
  for (const [p, c] of Object.entries(ADD)) assert.equal(byPath.get(p).sha256, sha(Buffer.from(c)));
  assert.ok(fs.statSync(path.join(opts.out, "site", "sso")).isDirectory(), "empty base directory kept");

  // provenance: outside the payload, not referenced from it, base source recorded as base-only
  const prov = JSON.parse(fs.readFileSync(path.join(opts.out, PROVENANCE), "utf8"));
  assert.equal(prov.base.cid, opts.baseCid); assert.deepEqual([prov.base.source.commit, prov.base.source.dirty], ["48a812d22", true]);
  assert.equal(prov.base.inventory.canonicalSha256, inv.inventorySha256);
  assert.equal(prov.composite.cid, r.newCid); assert.equal(prov.composite.car.sha256, r.car.sha256);
  assert.equal(prov.preservation.files.length, inv.filesCount);
  for (const f of prov.preservation.files) assert.equal(f.cid, baseFiles.get(f.path).cid);
  assert.equal(prov.additions.length, 5);
  assert.ok(!byPath.has(PROVENANCE));
  for (const f of car.files) assert.ok(!fs.readFileSync(path.join(opts.out, "site", f.path)).includes(r.newCid), `payload ${f.path} mentions the new CID`);
  assert.equal(fs.readFileSync(path.join(opts.out, "site", ".well-known/enclave-site-release.json"), "utf8"), BASE[".well-known/enclave-site-release.json"]);

  // the base is untouched, and the build is deterministic
  assert.deepEqual(capture(baseTree, opts.baseCid), inv);
  const again = await buildComposite({ ...opts, out: opts.out + "-2" });
  assert.equal(again.newCid, r.newCid); assert.equal(again.car.sha256, r.car.sha256);
});

test("a tampered CAR fails readCar", async (t) => {
  const { opts } = fixture(t);
  const r = await buildComposite(opts), b = Buffer.from(fs.readFileSync(path.join(opts.out, "site.car")));
  b[b.length - 1] ^= 1;
  assert.throws(() => lib.readCar(b, { expectRoot: r.newCid }), /hash|truncated|reachable|missing/);
});

// ---- strict options: nothing defaults, nothing can be switched off ----
test("every option is required and unknown options are refused", async (t) => {
  const { opts } = fixture(t);
  for (const k of ["baseCid", "expectFiles", "expectBytes", "expectInventorySha256", "expectAddonManifestSha256", "addonPins", "siteReleaseDir", "baseSourceCommit"]) {
    const o = { ...opts }; delete o[k]; await refuses(o, /required/);
  }
  await refuses({ ...opts, skipHashes: true }, /unknown option/);
  await refuses({ ...opts, expectBytes: MAX_TOTAL_BYTES + 1 }, /100 MiB/);
  await refuses({ ...opts, baseTree: opts.baseTree + "/" }, /absolute, normalized/);
});
test("out must be new and outside the inputs", async (t) => {
  const { opts, baseTree, addon } = fixture(t);
  await refuses({ ...opts, out: path.join(baseTree, "out") }, /inside baseTree/);
  await refuses({ ...opts, out: path.join(addon, "out") }, /inside addon/);
  fs.mkdirSync(opts.out);
  await assert.rejects(buildComposite(opts), /already exists/);
  assert.deepEqual(fs.readdirSync(opts.out), []);
});

// ---- base tree vs inventory ----
test("symlinks are refused in the base, the addon, and on input ancestors", async (t) => {
  const f1 = fixture(t);
  fs.symlinkSync("index.html", path.join(f1.baseTree, "link.html"));
  await refuses(f1.opts, /symlink/);
  const f2 = fixture(t);
  fs.symlinkSync("funding.html", path.join(f2.addon, "site-additions", "link.html"));
  await refuses(f2.opts, /symlink/);
  const f3 = fixture(t);
  fs.symlinkSync(path.join(f3.d, "base"), path.join(f3.d, "alias"));
  await refuses({ ...f3.opts, baseTree: path.join(f3.d, "alias", "site") }, /symlink/);
});
test("hard-linked base files are refused", async (t) => {
  const { opts, baseTree, d } = fixture(t);
  fs.linkSync(path.join(baseTree, "index.html"), path.join(d, "hardlink"));
  await refuses(opts, /hard-linked/);
});
test("a tampered, unlisted or missing base entry is refused", async (t) => {
  const f1 = fixture(t);
  fs.writeFileSync(path.join(f1.baseTree, "css/site.css"), "bodx{}\n");   // same size
  await refuses(f1.opts, /does not hash/);
  const f2 = fixture(t);
  fs.writeFileSync(path.join(f2.baseTree, "extra.txt"), "x");
  await refuses(f2.opts, /unlisted|more than/);
  const f3 = fixture(t);
  fs.mkdirSync(path.join(f3.baseTree, "empty-extra"));
  await refuses(f3.opts, /unlisted|more than/);
  const f4 = fixture(t);
  fs.rmSync(path.join(f4.baseTree, "js/chunks/a.js"));
  await refuses(f4.opts, /missing file/);
});
test("stale or mismatched index identity is refused", async (t) => {
  const f = fixture(t), other = lib.importDirectory(path.join(f.addon, "site-additions")).cid;
  await refuses({ ...f.opts, baseCid: other }, /inventory describes/);
  await refuses({ ...f.opts, expectInventorySha256: "0".repeat(64) }, /canonical sha256/);
  await refuses({ ...f.opts, expectFiles: f.opts.expectFiles + 1 }, /files/);
  // a self-consistent inventory + expectations naming another CID: the tree does not import to it
  rewriteJson(f.inventory, (j) => { j.claimedReleaseCID = other; });
  await refuses({ ...f.opts, baseCid: other }, /imports to/);
  // an index listing a file the tree lacks (counts and canonical hash consistent with the index)
  const g = fixture(t);
  let next;
  rewriteJson(g.inventory, (j) => {
    j.files.push({ path: "zz.html", bytes: 1, sha256: "e".repeat(64) }); j.filesCount++; j.bytes++;
    j.inventorySha256 = sha(Buffer.from(pyCanonical(j.files, j.directories))); next = j;
  });
  await refuses({ ...g.opts, expectFiles: next.filesCount, expectBytes: next.bytes, expectInventorySha256: next.inventorySha256 }, /missing file/);
});

// ---- addon ----
test("addon collisions are refused (exact, case-only, file-as-directory)", async (t) => {
  const drop = "css/site.funding-r2.0000000000000004.css";
  await refuses(fixture(t, { add: withAdd(drop, "css/site.css", "body{}\n") }).opts, /collides/);
  await refuses(fixture(t, { add: withAdd(drop, "CSS/site.funding-r2.0000000000000004.css", "x\n") }).opts, /case/);
  await refuses(fixture(t, { add: withAdd(drop, "index.html/x.js", "x\n") }).opts, /existing file/);
});
test("addon tamper, closure and pin mismatches are refused", async (t) => {
  const f1 = fixture(t);
  fs.writeFileSync(path.join(f1.addon, "site-additions", "funding.html"), "<!doctype html><title>fundinX</title>\n");
  await refuses(f1.opts, /does not hash/);
  const f2 = fixture(t);
  fs.writeFileSync(path.join(f2.addon, "site-additions", "js", "extra.js"), "x");
  await refuses(f2.opts, /unlisted|more than/);
  const f3 = fixture(t);
  fs.writeFileSync(path.join(f3.addon, "NOTES.txt"), "x");
  await refuses(f3.opts, /must contain exactly/);
  const f4 = fixture(t);
  fs.appendFileSync(path.join(f4.addon, "MANIFEST.json"), " ");
  await refuses(f4.opts, /MANIFEST.json is/);
  const f5 = fixture(t);
  rewriteJson(path.join(f5.addon, "ADDITIONS.json"), (j) => { j.pop(); });
  await refuses(f5.opts, /ADDITIONS.json differs/);
  const f6 = fixture(t);
  rewriteJson(f6.addonPins, (j) => { j.reviewed = false; });
  await refuses(f6.opts, /reviewed: true/);
  const f7 = fixture(t);
  rewriteJson(f7.addonPins, (j) => { j.inputs["site/js/pages/funding.js"] = "3".repeat(64); });
  await refuses(f7.opts, /inputs differ/);
});

// ---- failure after the first write: retained, marked, never qualified ----
test("a failure after writing leaves out in place, marked NOT-QUALIFIED, without provenance", async (t) => {
  // a base directory just under kubo's HAMT threshold (1106 links x 237 estimate bytes) that the two vendor additions push over it
  const base = { "index.html": "x\n" };
  for (let i = 0; i < 1106; i++) base[`vendor/f${String(i).padStart(4, "0")}${"x".repeat(196)}`] = String(i);
  const { opts } = fixture(t, { base, emptyDirs: [] });
  await assert.rejects(buildComposite(opts), /HAMT/);
  assert.ok(fs.existsSync(path.join(opts.out, FAILED)));
  assert.match(fs.readFileSync(path.join(opts.out, FAILED), "utf8"), /NOT QUALIFIED/);
  assert.ok(!fs.existsSync(path.join(opts.out, PROVENANCE))); assert.ok(!fs.existsSync(path.join(opts.out, "site.car")));
});
