// Model volumes reach a host COLD from replicas (sdk/storage/model-volumes.mjs, metal/volumes.mjs dist|fetch|table):
// a real reproducible volume (mkfs.ext4 + veritysetup, as metal/volumes.mjs builds it), published as a pinned chunk
// manifest, fetched into an EMPTY store through RawArtifacts from literal-IP replicas. The "DigitalOcean" mirrors are
// down, one replica lies, one is missing chunks; the fetch still succeeds from the remaining independent replica, every
// byte digest-checked, and the assembled image verifies against the PINNED dm-verity root (veritysetup verify).
// Refusals: a pin pointing at another (self-consistent) manifest, a table entry that disagrees with the manifest, no
// replica reachable. Fixture data only (a synthetic model tree); no network beyond 127.0.0.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageCID } from "../sdk/bootstrap/package.mjs";
import { RawArtifacts } from "../sdk/storage/raw-artifacts.mjs";
import { buildDistribution, decodeManifest, encodeManifest, fetchVolume, parseTable, tableText, preloadOf, writeFixedVhd, readVhdFooter, VHD_FOOTER_BYTES } from "../sdk/storage/model-volumes.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha = (b) => createHash("sha256").update(b).digest("hex");

function buildFixtureVolume() {
  const store = tmp("mv-store-"), src = tmp("mv-src-");
  fs.writeFileSync(path.join(src, "model.gguf"), Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(3 << 20, 7)]));
  fs.mkdirSync(path.join(src, "tokenizer"));
  fs.writeFileSync(path.join(src, "tokenizer", "vocab.txt"), "fixture vocabulary\n");
  execFileSync(process.execPath, [path.join(ROOT, "metal/volumes.mjs"), "build", "fixture-model-gguf", "--src", src, "--store", store], { stdio: "pipe" });
  return { store, dir: path.join(store, "fixture-model-gguf"), vol: JSON.parse(fs.readFileSync(path.join(store, "fixture-model-gguf", "volume.json"), "utf8")) };
}

// a raw-artifact replica: GET /<CIDv1 over sha256> serves the file named by that sha256 from dir; `mutate` lies
function replica(dir, { mutate = null, missing = new Set() } = {}) {
  const byCid = new Map();
  for (const f of fs.readdirSync(dir)) if (/^[0-9a-f]{64}$/.test(f)) byCid.set(packageCID(f), f);
  const srv = http.createServer((req, res) => {
    const f = byCid.get(req.url.slice(1));
    if (!f || missing.has(f)) { res.writeHead(404); return res.end(); }
    let body = fs.readFileSync(path.join(dir, f));
    if (mutate) body = mutate(f, body);
    res.writeHead(200, { "content-length": body.length }); res.end(body);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((c) => srv.close(c)) })));
}
async function deadAddress() { const r = await replica(tmp("mv-dead-")); await r.close(); return r.url; }

test("a volume published as a pinned manifest reaches an empty store from any honest replica; liars and dead mirrors only cost time", async () => {
  const { dir, vol } = buildFixtureVolume();
  const pub = tmp("mv-pub-");
  const { pin, manifest } = await buildDistribution(dir, pub, { chunkBytes: 1 << 20 });
  assert.ok(manifest.chunks.length >= 4, "several chunks");
  assert.deepEqual(preloadOf(vol), { preload: "ggml", graph: "model.gguf" });
  assert.equal(manifest.preload, "ggml");
  // the measured table carries the pin and the root the guest checks
  const table = parseTable(tableText([{ pin, manifest }]));
  const entry = table.get("fixture-model-gguf");
  assert.equal(entry.verity.root, vol.verity.root);
  assert.equal(entry.pin, pin);

  // two "DigitalOcean" mirrors, both down; a replica that flips a byte in every chunk; one missing half the chunks; one honest
  const doA = await deadAddress(), doB = await deadAddress();
  const liar = await replica(pub, { mutate: (f, b) => { if (f === pin) return b; const c = Buffer.from(b); c[c.length >> 1] ^= 1; return c; } });
  const half = await replica(pub, { missing: new Set(manifest.chunks.filter((_, i) => i % 2).map((c) => c.sha256)) });
  const honest = await replica(pub);
  try {
    const store = tmp("mv-cold-");
    const artifacts = new RawArtifacts({ gateways: [doA, doB, liar.url, half.url, honest.url], timeoutMs: 10000 });
    const got = await fetchVolume({ artifacts, entry, store });
    const img = path.join(store, "fixture-model-gguf", "volume.img");
    assert.equal(sha(fs.readFileSync(img)), sha(fs.readFileSync(path.join(dir, "volume.img"))), "the identical image");
    assert.equal(got.verity.root, vol.verity.root);
    assert.equal(got.distPin, pin);
    // the liar serves the manifest honestly (it corrupts chunks only): that verified copy is fine to accept; no CHUNK
    // came from it, and nothing at all from a dead mirror
    const chunkOrigins = new Set(artifacts.receipts.filter((r) => r.sha256 !== pin).map((r) => r.origin));
    assert.ok(!chunkOrigins.has(liar.url), "no chunk accepted from the liar");
    assert.ok(!artifacts.receipts.some((r) => r.origin === doA || r.origin === doB), "nothing from a dead mirror");
    assert.ok(chunkOrigins.has(honest.url), "the honest independent replica served chunks");
    // the guest's check, here on the host: the assembled image verifies against the PINNED root
    const v = got.verity;
    const ver = spawnSync("veritysetup", ["verify", "--data-blocks", String(v.dataBlocks), "--hash-offset", String(v.hashOffset),
      "--data-block-size", "4096", "--hash-block-size", "4096", "--salt", v.salt, img, img, entry.verity.root], { encoding: "utf8" });
    assert.equal(ver.status, 0, ver.stderr);
    // no partial directories left by the failures along the way
    assert.deepEqual(fs.readdirSync(store), ["fixture-model-gguf"]);

    // a second fetch never merges into the existing volume
    await assert.rejects(fetchVolume({ artifacts, entry, store }), /already in the store/);

    // every independent replica down: refused, nothing left behind
    const store2 = tmp("mv-cold2-");
    await assert.rejects(fetchVolume({ artifacts: new RawArtifacts({ gateways: [doA, doB], timeoutMs: 2000 }), entry, store: store2 }), /no artifact source/);
    assert.deepEqual(fs.readdirSync(store2), []);
  } finally { await Promise.all([liar.close(), half.close(), honest.close()]); }
});

test("a pin can only ever mean the table's volume", async () => {
  const { dir } = buildFixtureVolume();
  const pub = tmp("mv-pub2-");
  const { pin, manifest } = await buildDistribution(dir, pub, { chunkBytes: 1 << 20 });
  const entry = parseTable(tableText([{ pin, manifest }])).get("fixture-model-gguf");
  // a self-consistent manifest for ANOTHER model, encoded canonically: its pin differs, so serving it under ours fails
  const other = { ...manifest, verity: { ...manifest.verity, root: "ab".repeat(32) } };
  const forged = encodeManifest(other);
  assert.notEqual(forged.pin, pin);
  const swap = await replica(pub, { mutate: (f, b) => (f === pin ? forged.bytes : b) });
  try {
    await assert.rejects(fetchVolume({ artifacts: new RawArtifacts({ gateways: [swap.url], timeoutMs: 5000 }), entry, store: tmp("mv-s-") }), /no artifact source/);
  } finally { await swap.close(); }
  // a table entry that disagrees with the manifest behind its pin (another root): refused even with honest bytes
  const honest = await replica(pub);
  try {
    const wrong = { ...entry, verity: { ...entry.verity, root: "cd".repeat(32) } };
    await assert.rejects(fetchVolume({ artifacts: new RawArtifacts({ gateways: [honest.url], timeoutMs: 5000 }), entry: wrong, store: tmp("mv-w-") }), /not the table's volume/);
  } finally { await honest.close(); }
  // decodeManifest refuses non-canonical bytes and a pin that does not hash them
  const bytes = Buffer.from(JSON.stringify(manifest, null, 1));
  assert.throws(() => decodeManifest(bytes, sha(bytes)), /not canonical/);
  assert.throws(() => decodeManifest(encodeManifest(manifest).bytes, "00".repeat(32)), /does not match its pin/);
});

test("the table is strict: names, geometry, preload and pins", () => {
  const ok = "a.gguf 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 00ff 4096 4096 100 101 450560 ggml m.gguf " + "11".repeat(32) + "\n";
  assert.equal(parseTable(ok).get("a.gguf").verity.dataBlocks, 100);
  for (const bad of [
    ok.replace("a.gguf", "A.GGUF"), ok.replace(" 101 ", " 100 "), ok.replace(" ggml ", " onnx "), ok.replace(" m.gguf ", " ../m.gguf "),
    ok.replace(" ggml m.gguf ", " none m.gguf "), ok.replace(" 450560 ", " 409600 "), ok.trimEnd(), ok + ok, ok.replace(" 4096 4096 ", " 512 4096 "),
  ]) assert.throws(() => parseTable(bad), /model volume table|malformed/, JSON.stringify(bad.slice(0, 40)));
});

// A Windows host attaches the same image as a fixed VHD (windows/vbslike/manager); the partition's monitor finds the
// volume among its disks by the rule dm-verity applies first: the top-level hash block, at hashStartBlock, hashes with
// the salt to the pinned root (isolation/m2/modelspec HoldsRoot). Both checked on a real metal/volumes.mjs volume.
test("the volume as a fixed VHD is its exact bytes plus a footer, and its hash tree's top block hashes to the pinned root", async () => {
  const { dir, vol } = buildFixtureVolume();
  const img = fs.readFileSync(path.join(dir, "volume.img"));
  const salt = Buffer.from(vol.verity.salt, "hex"), top = img.subarray(vol.verity.hashStartBlock * 4096, vol.verity.hashStartBlock * 4096 + 4096);
  assert.equal(sha(Buffer.concat([salt, top])), vol.verity.root, "sha256(salt || top-level hash block) is the root");
  assert.notEqual(sha(Buffer.concat([salt, img.subarray((vol.verity.hashStartBlock - 1) * 4096, vol.verity.hashStartBlock * 4096)])), vol.verity.root, "not the superblock");
  const { path: vhd, bytes } = await writeFixedVhd(dir);
  const v = fs.readFileSync(vhd);
  assert.equal(bytes, img.length + VHD_FOOTER_BYTES);
  assert.ok(v.subarray(0, img.length).equals(img), "the guest sees exactly the image");
  assert.deepEqual(readVhdFooter(v.subarray(img.length)), { size: img.length, fixed: true });
  const again = await writeFixedVhd(dir);
  assert.equal(sha(fs.readFileSync(again.path)), sha(v), "reproducible");
  const bad = Buffer.from(v.subarray(img.length)); bad[100] ^= 1;
  assert.throws(() => readVhdFooter(bad), /checksum/);
  // an independent reader: QEMU's vpc driver, sized by the footer's current size, converts back to the same bytes
  const qi = spawnSync("qemu-img", ["--version"], { encoding: "utf8" });
  if (qi.status === 0) {
    const raw = path.join(tmp("mv-vhd-"), "back.raw");
    const c = spawnSync("qemu-img", ["convert", "--image-opts", `driver=vpc,force_size_calc=current_size,file.filename=${vhd}`, "-O", "raw", raw], { encoding: "utf8" });
    assert.equal(c.status, 0, c.stderr);
    assert.equal(sha(fs.readFileSync(raw)), sha(img), "qemu-img reads the VHD as the image");
    const info = JSON.parse(spawnSync("qemu-img", ["info", "--output=json", "-f", "vpc", vhd], { encoding: "utf8" }).stdout);
    assert.equal(info.format, "vpc");
  }
});
