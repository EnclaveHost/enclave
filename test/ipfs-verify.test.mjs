// ipfs-verify.mjs: the JavaScript CID verifier answers exactly as wasm/ipfs_fetch.py does -- the same bytes for honest CARs,
// a refusal for tampered, incomplete, oversized and diamond DAGs -- and fetchVerified checks a raw block and a CAR end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { verifyCar, fetchVerified, cidBytes } from "../shielded/anchor/avf/runner/ipfs-verify.mjs";

const WASM = new URL("../wasm/", import.meta.url).pathname;
const varint = (n) => { const o = []; while (n >= 0x80) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
const sha = (b) => crypto.createHash("sha256").update(b).digest();
const cidV1 = (codec, block) => Buffer.concat([varint(1), varint(codec), varint(0x12), varint(32), sha(block)]);
const b32 = (buf) => { const A = "abcdefghijklmnopqrstuvwxyz234567"; let bits = 0, v = 0, s = ""; for (const x of buf) { v = (v << 8) | x; bits += 8; while (bits >= 5) { s += A[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) s += A[(v << (5 - bits)) & 31]; return "b" + s; };
const pbField = (f, bytes) => Buffer.concat([varint((f << 3) | 2), varint(bytes.length), bytes]);
const dagpb = (links, data = Buffer.alloc(0)) => Buffer.concat([...links.map((l) => pbField(2, pbField(1, l))), pbField(1, data)]);
const unixfsFile = (bytes) => Buffer.concat([Buffer.from([0x08, 0x02]), pbField(2, bytes)]);   // Type=File, Data
const car = (blocks) => Buffer.concat([varint(3), Buffer.from([0xa0, 0x00, 0x00]),
  ...blocks.map(([cid, b]) => { const body = Buffer.concat([cid, b]); return Buffer.concat([varint(body.length), body]); })]);
const py = (cid, carBuf, max) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "car-")), "x.car"); fs.writeFileSync(f, carBuf);
  try {
    const out = execFileSync("python3", ["-c", "import sys,hashlib; sys.path.insert(0, sys.argv[1]); import ipfs_fetch as m; d=m.verify_car(sys.argv[2], open(sys.argv[3],'rb').read(), int(sys.argv[4])); print('ok', hashlib.sha256(d).hexdigest())",
      WASM, cid, f, String(max)], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    return out;
  } catch { return "refused"; }
};
const js = (cid, carBuf, max) => { try { return "ok " + sha(verifyCar(cid, carBuf, max)).toString("hex"); } catch { return "refused"; } };

function sample() {
  const leaves = [crypto.randomBytes(1000), crypto.randomBytes(700), crypto.randomBytes(1000)];
  const leafCids = leaves.map((l) => cidV1(0x55, l));
  const root = dagpb([leafCids[0], leafCids[1], leafCids[2], leafCids[0]], Buffer.from([0x08, 0x02]));   // a repeated chunk: emitted twice
  const rootCid = cidV1(0x70, root);
  return { leaves, leafCids, root, rootCid, cid: b32(rootCid), want: Buffer.concat([leaves[0], leaves[1], leaves[2], leaves[0]]) };
}

test("the same answer as ipfs_fetch.py: honest, tampered, missing, oversized, a dag-pb leaf, CIDv0", () => {
  const s = sample();
  const honest = car([[s.rootCid, s.root], ...s.leafCids.map((c, i) => [c, s.leaves[i]])]);
  assert.equal(js(s.cid, honest, 1 << 20), "ok " + sha(s.want).toString("hex"));
  assert.equal(py(s.cid, honest, 1 << 20), js(s.cid, honest, 1 << 20));
  const bad = Buffer.from(s.leaves[1]); bad[0] ^= 1;
  const tampered = car([[s.rootCid, s.root], [s.leafCids[0], s.leaves[0]], [s.leafCids[1], bad], [s.leafCids[2], s.leaves[2]]]);
  assert.equal(js(s.cid, tampered, 1 << 20), "refused"); assert.equal(py(s.cid, tampered, 1 << 20), "refused");
  const missing = car([[s.rootCid, s.root], [s.leafCids[0], s.leaves[0]], [s.leafCids[2], s.leaves[2]]]);
  assert.equal(js(s.cid, missing, 1 << 20), "refused"); assert.equal(py(s.cid, missing, 1 << 20), "refused");
  assert.equal(js(s.cid, honest, 3000), "refused"); assert.equal(py(s.cid, honest, 3000), "refused");
  const other = car(s.leafCids.map((c, i) => [c, s.leaves[i]]));
  assert.equal(js(s.cid, other, 1 << 20), "refused", "the requested root is not in the CAR");
  // a dag-pb leaf (UnixFS Data inside), addressed as CIDv0 (Qm...)
  const leaf = dagpb([], unixfsFile(Buffer.from("hello world")));
  const v0 = Buffer.concat([Buffer.from([0x12, 0x20]), sha(leaf)]);
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + v0.toString("hex")), qm = ""; while (n > 0n) { qm = B58[Number(n % 58n)] + qm; n /= 58n; }
  assert.ok(qm.startsWith("Qm"));
  assert.deepEqual(cidBytes(qm), v0);
  const c0 = car([[v0, leaf]]);
  assert.equal(js(qm, c0, 1 << 20), "ok " + sha(Buffer.from("hello world")).toString("hex"));
  assert.equal(py(qm, c0, 1 << 20), js(qm, c0, 1 << 20));
});

test("a hash-valid diamond DAG is refused by the visit budget, not walked for ever", () => {
  let node = dagpb([], Buffer.from([0x08, 0x02])), cid = cidV1(0x70, node);
  const blocks = [[cid, node]];
  for (let i = 0; i < 40; i++) { node = dagpb([cid, cid], Buffer.from([0x08, 0x02])); cid = cidV1(0x70, node); blocks.push([cid, node]); }
  const t0 = Date.now();
  assert.equal(js(b32(cid), car(blocks), 1 << 20), "refused");
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(py(b32(cid), car(blocks), 1 << 20), "refused");
});

test("fetchVerified: a raw block by hash, a CAR by its root; a lying gateway is refused", async () => {
  const s = sample();
  const raw = crypto.randomBytes(500), rawCid = b32(cidV1(0x55, raw));
  const honest = car([[s.rootCid, s.root], ...s.leafCids.map((c, i) => [c, s.leaves[i]])]);
  const gw = (body) => async (url, o) => {
    assert.ok(url.startsWith("https://gw.example/ipfs/"));
    return new Response(typeof body === "function" ? body(url, o) : body, { status: 200 });
  };
  assert.deepEqual(await fetchVerified(rawCid, "https://gw.example/", 1 << 20, 5000, gw(raw)), raw);
  await assert.rejects(fetchVerified(rawCid, "https://gw.example", 1 << 20, 5000, gw(crypto.randomBytes(500))), /does not match/);
  await assert.rejects(fetchVerified(rawCid, "https://gw.example", 100, 5000, gw(raw)), /larger than allowed/);
  const got = await fetchVerified(s.cid, "https://gw.example", 1 << 20, 5000, gw((url, o) => {
    assert.match(url, /\?format=car&dag-scope=all$/); assert.equal(o.headers.accept, "application/vnd.ipld.car"); return honest; }));
  assert.deepEqual(got, s.want);
  await assert.rejects(fetchVerified(s.cid, "https://gw.example", 1 << 20, 5000, async () => new Response("no", { status: 504 })), /504/);
});
