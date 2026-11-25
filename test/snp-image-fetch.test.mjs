// rpc/snp/image-fetch.mjs: a whole-VM image fetched by content address for a host's instance pool. Every byte is taken
// from a gateway and accepted only at the length and SHA-256 named: the manifest's by the catalog version, each
// artifact's by the manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ARTIFACTS, contentRef, fetchableImage, readManifest, fetchContent, fetchImage } from "../rpc/snp/image-fetch.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const ROOT = "3d".repeat(32), CMDLINE = "root=/dev/mapper/vroot ro enclave.roothash=" + ROOT + " console=ttyS0";
const cidOf = (b) => "bafkrei" + sha(b).replace(/[^a-z2-7]/g, "a").slice(0, 52);
const GW = "https://gw.test/ipfs/";

// a published image: four artifacts and the manifest that names them, served by content id
function published(over = {}) {
  const files = { vmlinuz: Buffer.from("kernel bytes"), "initrd.img": Buffer.from("initrd bytes"), "root.img": Buffer.alloc(300_000, 7), "root.verity": Buffer.from("verity tree") };
  const artifacts = Object.fromEntries(Object.entries(files).map(([n, b]) => [n, { bytes: b.length, sha256: sha(b), cid: cidOf(b) }]));
  const manifest = Buffer.from(JSON.stringify({ schema: "enclave-rpc-snp-image/1", cmdline: CMDLINE, rootHash: ROOT, artifacts, ...over }));
  const store = new Map([[cidOf(manifest), manifest], ...Object.values(files).map((b) => [cidOf(b), b])]);
  const image = { rootHash: ROOT, cmdlineSha256: sha(CMDLINE), manifest: { cid: cidOf(manifest), sha256: sha(manifest), bytes: manifest.length } };
  return { files, manifest, store, image };
}
function gateway(store, { asked = [], tamper = null } = {}) {
  return async (url) => {
    asked.push(url);
    const cid = url.slice(url.lastIndexOf("/") + 1);
    let body = store.get(cid);
    if (!body) return { ok: false, status: 404, body: null };
    if (tamper) body = tamper(url, body);
    return { ok: true, status: 200, body: (async function* () { for (let i = 0; i < body.length; i += 65536) yield body.subarray(i, i + 65536); })() };
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "imgfetch-"));
const opts = (fetch, over = {}) => ({ gateways: [GW], maxBytes: 10 << 20, fetch, freeBytes: () => 1 << 30, ...over });

test("a content reference is a CID, a SHA-256 and a length, and nothing looser", () => {
  const ok = { cid: "bafkreigcdalt2wtxwqrf2pvn2mjgit3yfod7aytpiwmju6yifn26z6flmi", sha256: "ab".repeat(32), bytes: 5 };
  assert.deepEqual(contentRef({ ...ok, extra: 1 }, "x"), ok);
  assert.deepEqual(contentRef({ ...ok, cid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" }, "x").cid.slice(0, 2), "Qm");
  for (const bad of [{ cid: "../etc/passwd" }, { cid: "bafy?x=1" }, { cid: "https://evil/" }, { sha256: "AB".repeat(32) }, { bytes: 0 }, { bytes: 1.5 }, { bytes: "5" }])
    assert.throws(() => contentRef({ ...ok, ...bad }, "x"), /x\./, JSON.stringify(bad));
  assert.throws(() => contentRef(null, "x"), /must be/);
  assert.throws(() => fetchableImage({ rootHash: ROOT, cmdlineSha256: sha(CMDLINE), manifest: { ...ok, bytes: 1 << 20 } }), /larger than a manifest/);
  assert.throws(() => fetchableImage({ rootHash: "x", cmdlineSha256: sha(CMDLINE), manifest: ok }), /root hash/);
});

test("the image arrives complete under its root hash, exactly as published, and is not fetched twice", async () => {
  const p = published(), dir = tmp(), asked = [];
  const r = await fetchImage(p.image, dir, opts(gateway(p.store, { asked })));
  assert.deepEqual([r.rootHash, r.held], [ROOT, true]);
  assert.deepEqual(fs.readdirSync(dir), [ROOT]);
  assert.deepEqual(fs.readdirSync(path.join(dir, ROOT)).sort(), ["IMAGE.json", ...ARTIFACTS].sort());
  assert.ok(fs.readFileSync(path.join(dir, ROOT, "IMAGE.json")).equals(p.manifest), "the manifest on disk is the published one: launch.py checks the artifacts against it");
  for (const n of ARTIFACTS) assert.ok(fs.readFileSync(path.join(dir, ROOT, n)).equals(p.files[n]), n);
  assert.equal(asked.length, 5);
  assert.equal(asked[0], GW + p.image.manifest.cid);
  await fetchImage(p.image, dir, opts(async () => { throw new Error("a held image is not fetched again"); }));
});

test("a gateway cannot substitute: other bytes, more bytes or fewer are refused and nothing is left behind", async () => {
  const p = published();
  const rootCid = cidOf(p.files["root.img"]);
  for (const [tamper, why] of [
    [(u, b) => u.endsWith(rootCid) ? Buffer.alloc(b.length, 8) : b, /served other bytes than named/],
    [(u, b) => u.endsWith(rootCid) ? Buffer.concat([b, Buffer.from("x")]) : b, /served more bytes than named/],
    [(u, b) => u.endsWith(rootCid) ? b.subarray(0, 100) : b, /served 100 of 300000 bytes/],
    [(u, b) => u.endsWith(p.image.manifest.cid) ? Buffer.from(b.toString().replace("ttyS0", "ttyS1")) : b, /served other bytes than named/],
  ]) {
    const dir = tmp();
    await assert.rejects(fetchImage(p.image, dir, opts(gateway(p.store, { tamper }))), why);
    assert.deepEqual(fs.readdirSync(dir), [], "no image and no partial download remain");
  }
});

test("a second gateway serves what the first refused or corrupted", async () => {
  const p = published(), dir = tmp(), asked = [];
  const good = gateway(p.store, { asked });
  const fetch = async (url) => url.startsWith("https://bad.test/") ? (url.endsWith(p.image.manifest.cid) ? { ok: false, status: 504, body: null } : gateway(p.store, { tamper: (u, b) => Buffer.alloc(b.length) })(url)) : good(url);
  await fetchImage(p.image, dir, opts(fetch, { gateways: ["https://bad.test/ipfs/", GW] }));
  assert.equal(asked.length, 5);
  for (const n of ARTIFACTS) assert.ok(fs.readFileSync(path.join(dir, ROOT, n)).equals(p.files[n]));
  await assert.rejects(fetchContent({ cid: p.image.manifest.cid, sha256: "00".repeat(32), bytes: 3 }, path.join(tmp(), "x"), { gateways: ["https://bad.test/ipfs/"], fetch }), /no gateway served .*bad\.test: answered 504/);
});

test("a manifest for another image, with other files, or too large for this host is refused before any artifact is fetched", async () => {
  const cases = [
    [published({ rootHash: "4e".repeat(32) }), {}, /another root hash/],
    [published({ cmdline: CMDLINE + " init=/bin/sh" }), {}, /command line is not the version's/],
    [published({ artifacts: { vmlinuz: { bytes: 1, sha256: "ab".repeat(32), cid: "bafkreigcdalt2wtxwqrf2pvn2mjgit3yfod7aytpiwmju6yifn26z6flmi" } } }), {}, /must list exactly vmlinuz, initrd\.img, root\.img, root\.verity/],
    [published(), { maxBytes: 1000 }, /more than this host fetches \(1000\)/],
    [published(), { freeBytes: () => 300_100 }, /a tenth to spare; 300100 are free/],
  ];
  for (const [p, over, why] of cases) {
    const dir = tmp(), asked = [];
    await assert.rejects(fetchImage(p.image, dir, opts(gateway(p.store, { asked }), over)), why);
    assert.equal(asked.length, 1, "only the manifest was asked for");
    assert.deepEqual(fs.readdirSync(dir), []);
  }
  // a path in place of an artifact name never reaches the filesystem
  const p = published();
  const evil = JSON.parse(p.manifest); evil.artifacts["../../x"] = evil.artifacts.vmlinuz;
  assert.throws(() => readManifest(Buffer.from(JSON.stringify(evil)), p.image, { maxBytes: 1 << 30 }), /must list exactly/);
  assert.throws(() => readManifest(Buffer.from("not json"), p.image, { maxBytes: 1 << 30 }), /not JSON/);
});
