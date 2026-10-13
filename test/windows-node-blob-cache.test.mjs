// The host-side cache for public, pinned content (windows/node/blob-cache.mjs, docs/design/shield-blob-cache.md).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { createBlobCache, refuseSource, isPublicAddress } from "../windows/node/blob-cache.mjs";

const servers = [];
after(() => { for (const s of servers) s.close(); });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const blob = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255));
const SRC = "https://images.example.org/disk.img";

async function rig({ objects, maxBytes, maxObjectBytes, slow = 0 } = {}) {
  const calls = [];
  const fetchSource = async (src) => {
    calls.push(src);
    const body = objects[src];
    if (!body) return { status: 404, headers: {}, stream: Readable.from([]) };
    async function* chunks() { for (let i = 0; i < body.length; i += 16384) { if (slow) await new Promise((r) => setTimeout(r, slow)); yield body.subarray(i, i + 16384); } }
    return { status: 200, headers: { "content-length": String(body.length) }, stream: Readable.from(chunks()) };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blobs-"));
  const cache = createBlobCache({ dir, fetchSource, ...(maxBytes ? { maxBytes } : {}), ...(maxObjectBytes ? { maxObjectBytes } : {}) });
  const server = http.createServer((req, res) => { void cache.handle(req, res); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const get = (h, src, headers = {}) => new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: server.address().port, path: `/sha256/${h}${src ? `?src=${encodeURIComponent(src)}` : ""}`, headers }, (res) => {
      const parts = []; res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts), complete: res.complete }));
      res.on("error", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts), complete: false }));
      res.on("aborted", () => {});
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message, body: Buffer.alloc(0), complete: false }));
  });
  return { cache, get, calls, dir };
}

test("a miss streams the object and caches it; the next request is a hit from disk (the source is asked once)", async () => {
  const body = blob(200_000, 1), h = sha(body);
  const r = await rig({ objects: { [SRC]: body } });
  const a = await r.get(h, SRC);
  assert.equal(a.status, 200); assert.equal(a.headers["x-enclave-blob"], "miss"); assert.ok(a.body.equals(body));
  assert.ok(r.cache.has(h));
  const b = await r.get(h, SRC);
  assert.equal(b.headers["x-enclave-blob"], "hit"); assert.ok(b.body.equals(body));
  assert.equal(r.calls.length, 1);
  const c = await r.get(h);                                   // a cached object needs no src at all
  assert.ok(c.body.equals(body));
});

test("Range on a cached object resumes from the byte asked for", async () => {
  const body = blob(100_000, 2), h = sha(body);
  const r = await rig({ objects: { [SRC]: body } });
  await r.get(h, SRC);
  const part = await r.get(h, null, { range: "bytes=60000-" });
  assert.equal(part.status, 206);
  assert.equal(part.headers["content-range"], `bytes 60000-99999/100000`);
  assert.ok(part.body.equals(body.subarray(60000)));
  assert.equal((await r.get(h, null, { range: "bytes=200000-" })).status, 416);
});

test("an object whose sha256 is not the pinned one is never cached (and the requester sees a cut body)", async () => {
  const body = blob(50_000, 3), wrong = "ab".repeat(32);
  const r = await rig({ objects: { [SRC]: body } });
  const a = await r.get(wrong, SRC);
  assert.ok(!a.complete || a.body.length !== body.length || a.status !== 200, "not a clean whole answer");
  assert.equal(r.cache.has(wrong), false);
  assert.equal(fs.readdirSync(r.dir).filter((n) => n.startsWith(".tmp")).length, 0, "no temp file left behind");
});

test("sources the host must never fetch are refused before any request", async () => {
  for (const [src, why] of [["http://images.example.org/x", /https/], [`${SRC}?X-Amz-Signature=abc`, /query/],
    ["https://user:pw@images.example.org/x", /credentials/], ["https://10.0.0.5/x", /public/], ["https://[::1]/x", /public/], ["not a url", /URL/]])
    assert.match(refuseSource(src), why, src);
  assert.equal(refuseSource(SRC), "");
  const r = await rig({ objects: {} });
  const a = await r.get("cd".repeat(32), `${SRC}?sig=1`);
  assert.equal(a.status, 403); assert.equal(r.calls.length, 0);
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "100.64.0.1", "169.254.1.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["1.1.1.1", "5.78.85.108", "2606:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("two requests at once share one download", async () => {
  const body = blob(300_000, 4), h = sha(body);
  const r = await rig({ objects: { [SRC]: body }, slow: 2 });
  const [a, b] = await Promise.all([r.get(h, SRC), r.get(h, SRC)]);
  assert.ok(a.body.equals(body) && b.body.equals(body));
  assert.equal(r.calls.length, 1);
});

test("the cache stays under its cap, least recently used out first; an oversized object is refused", async () => {
  const one = blob(40_000, 5), two = blob(40_000, 6), three = blob(40_000, 7);
  const objects = { [`${SRC}1`]: one, [`${SRC}2`]: two, [`${SRC}3`]: three };
  const r = await rig({ objects, maxBytes: 100_000 });
  await r.get(sha(one), `${SRC}1`);
  await new Promise((ok) => setTimeout(ok, 20));
  await r.get(sha(two), `${SRC}2`);
  await new Promise((ok) => setTimeout(ok, 20));
  await r.get(sha(three), `${SRC}3`);
  assert.equal(r.cache.has(sha(one)), false, "the oldest went");
  assert.ok(r.cache.has(sha(two)) && r.cache.has(sha(three)));
  const big = await rig({ objects: { [SRC]: blob(10_000, 8) }, maxObjectBytes: 5_000 });
  assert.equal((await big.get(sha(blob(10_000, 8)), SRC)).status, 413);
});
