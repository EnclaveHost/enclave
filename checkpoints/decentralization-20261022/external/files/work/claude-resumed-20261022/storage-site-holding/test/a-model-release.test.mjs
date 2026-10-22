// The adapter model (tools/adapter-model.mjs, line-mapped to s3-ipfs-adapter) against the REAL reviewed release (read-only):
// the 884 files under one prefix give exactly bafybeifkfgxsjz6…, with exactly its blocks (a CAR written from the model's blocks
// is byte-identical to the release's site.car), whatever else the bucket holds; and the ways a hold can go wrong change or
// drop the CID. Offline; nothing is written outside a temporary directory.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adapterIndex, cidString, cidBytes, leavesOf, fileDag, RAW, CHUNK } from "../tools/adapter-model.mjs";

const TOOLS = process.env.SITE_RELEASE_TOOLS || "/home/steven/Documents/Codex/2026-10-18/wo/work/claude-resumed-20261022/site-release-stage/src/scripts/site-release";
const REL = process.env.SITE_RELEASE_DIR || "/home/steven/Documents/Codex/2026-10-18/wo/work/claude-resumed-20261022/site-release-stage/release/bafybeifkfgxsjz6gnj234fvdkxa37pc4fcevydu6tb55wtidjejfsuxake";
const { writeCar } = await import(path.join(TOOLS, "car.mjs"));
const { importFile } = await import(path.join(TOOLS, "unixfs.mjs"));
const m = JSON.parse(fs.readFileSync(path.join(REL, "release.json"), "utf8"));
const CID = m.cid, PRE = `sites/${CID}/`;
const site = Object.fromEntries(m.files.map((f) => [f.path, fs.readFileSync(path.join(REL, "site", f.path))]));
const bucketWith = (pre, extra = {}) => ({ ...Object.fromEntries(Object.entries(site).map(([p, b]) => [pre + p, b])), ...extra });
// what a production bucket already holds next to the hold: pins, the leaves cache, a directory marker, another site
const DECOYS = { "pins/bafkreia4wrrx3ljhfog5r4sa7yd5e3d6bblbvngwyjnmce2q2f3grbu36e": Buffer.from("a pinned logo"),
  ".enclave-index/leaves.bin": Buffer.from("derived state"), "sites/": Buffer.alloc(0), "sites/bafyother/index.html": Buffer.from("<p>other</p>") };

test("884 files under sites/<CID>/ in a shared bucket: the adapter's directory there IS the release CID, block for block", () => {
  const idx = adapterIndex(bucketWith(PRE, DECOYS), "");
  assert.equal(idx.truncated, false);
  assert.equal(idx.dirs.get(`sites/${CID}`), CID);
  for (const f of m.files) assert.equal(idx.files.find((x) => x.rel === PRE + f.path).cid, f.cid, f.path);
  // every block of the release: dag-pb nodes from the model, raw leaves from the bytes the adapter would range-read
  const blocks = new Map(idx.nodes);
  for (const b of Object.values(site)) for (let off = 0; off < b.length || off === 0; off += CHUNK) {
    const c = b.subarray(off, off + CHUNK); blocks.set(cidString(cidBytes(RAW, leavesOf(c)[0])), c); if (!b.length) break; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hold-model-"));
  try {
    const car = writeCar(path.join(tmp, "model.car"), CID, blocks);
    assert.equal(car.sha256, m.car.sha256, "a CAR of the model's DAG is byte-identical to the release's site.car");
    assert.equal(car.bytes, m.car.bytes);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("the CID does not depend on where the prefix sits (deployment prefix, depth) or on directory markers inside it", () => {
  assert.equal(adapterIndex(bucketWith("public/" + PRE, { "public/x": Buffer.from("x") }), "public/").dirs.get(`sites/${CID}`), CID);
  assert.equal(adapterIndex(bucketWith(`a/b/c/${CID}/`), "").dirs.get(`a/b/c/${CID}`), CID);
  const marked = bucketWith(PRE, { [PRE + "assets/"]: Buffer.alloc(0), [PRE + "js/chunks/"]: Buffer.alloc(0) });
  assert.equal(adapterIndex(marked, "").dirs.get(`sites/${CID}`), CID);
});

test("negative controls: anything but exactly the release under the prefix gives another CID or none", () => {
  const at = (bucket, maxKeys) => adapterIndex(bucket, "", maxKeys).dirs.get(`sites/${CID}`);
  assert.notEqual(at(bucketWith(PRE, { [PRE + "stray.txt"]: Buffer.from("x") })), CID, "an extra object");
  const missing = bucketWith(PRE); delete missing[PRE + "favicon.ico"];
  assert.notEqual(at(missing), CID, "a missing file");
  const changed = bucketWith(PRE); changed[PRE + "index.html"] = Buffer.concat([site["index.html"], Buffer.from(" ")]);
  assert.notEqual(at(changed), CID, "changed bytes");
  const collide = bucketWith(PRE, { [PRE + "css"]: Buffer.from("a file where a directory is") });
  const ci = adapterIndex(collide, "");
  assert.notEqual(ci.dirs.get(`sites/${CID}`), CID, "a file/directory collision");
  // maxKeys: S3 lists pins/ before sites/, so a cap drops the hold's tail and the directory is not the release
  const capped = adapterIndex(bucketWith(PRE, DECOYS), "", 500);
  assert.equal(capped.truncated, true);
  assert.notEqual(capped.dirs.get(`sites/${CID}`), CID, "a truncated listing");
});

test("file DAGs: the model equals the accepted importer at every layout boundary (0, 1, chunk, chunk+1, 174 and 175 chunks)", () => {
  const big = Buffer.alloc(174 * CHUNK + 1); for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 255;   // one buffer, sliced
  for (const n of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 174 * CHUNK, 174 * CHUNK + 1]) {
    const b = big.subarray(0, n);
    const mine = fileDag(leavesOf(b), b.length), theirs = importFile(b);
    assert.equal(cidString(mine.cid), cidString(theirs.cid), `${n} bytes`);
    assert.equal(mine.dagSize, theirs.tsize, `${n} bytes tsize`);
  }
});
