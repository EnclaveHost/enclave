// The pin sweep's CAR reader. This is the piece that decides whether the fleet
// can launch an app, so the failure that matters is the FALSE GREEN: nan's kubo
// answers a CID it does not hold with HTTP 200 and a 59-byte header-only CAR
// that NAMES the root in its `roots` array and carries no blocks. Read the
// header and it looks like a hit; that is how the sweep passed 140 CIDs on
// 2026-08-26 while the runner could not prefetch one of them.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { cidStrToBytes, uvarint, cidLen, carHasRoot }
  from "../scripts/catalog-pin-sweep.mjs";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const b32 = (buf) => {                       // multibase 'b': base32 lower, no pad
  let bits = 0, acc = 0, out = "b";
  for (const byte of buf) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; out += B32[(acc >> bits) & 31]; }
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
};
const uvar = (n) => {                        // unsigned LEB128
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
};
const rawCid = (data) =>                     // CIDv1 raw (0x55) sha2-256
  Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), crypto.createHash("sha256").update(data).digest()]);

// The exact shape kubo emits for a CID it does not have: a valid CARv1 whose
// dag-cbor header carries {roots:[<cid>], version:1} and nothing after it.
const headerOnlyCar = (cid) => {
  const body = Buffer.concat([
    Buffer.from([0xa2, 0x65]), Buffer.from("roots"),
    Buffer.from([0x81, 0xd8, 0x2a, 0x58, cid.length + 1, 0x00]), cid,
    Buffer.from([0x67]), Buffer.from("version"), Buffer.from([0x01]),
  ]);
  return Buffer.concat([uvar(body.length), body]);
};
const blockEntry = (cid, data) =>
  Buffer.concat([uvar(cid.length + data.length), cid, data]);

const streamOf = (buf, chunkSize = 64 * 1024) => new ReadableStream({
  start(controller) {
    for (let i = 0; i < buf.length; i += chunkSize)
      controller.enqueue(new Uint8Array(buf.subarray(i, i + chunkSize)));
    controller.close();
  },
});

test("cidStrToBytes round-trips a CIDv1 base32 string", () => {
  const cid = rawCid(Buffer.from("enclave"));
  assert.deepEqual(cidStrToBytes(b32(cid)), cid);
  // a real catalog CID decodes to the CIDv1 dag-pb prefix (0x01 0x70 0x12 0x20)
  const eyesoff = cidStrToBytes("bafybeigjv7ydvfrubywabvdzemzm2af6oy72q2juhmmr5ynzbc2ncqsjzy");
  assert.equal(eyesoff.length, 36);
  assert.deepEqual([...eyesoff.subarray(0, 4)], [0x01, 0x70, 0x12, 0x20]);
});

test("cidStrToBytes decodes CIDv0 base58btc", () => {
  const bytes = cidStrToBytes("QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH");
  assert.equal(bytes.length, 34);
  assert.deepEqual([...bytes.subarray(0, 2)], [0x12, 0x20]);
});

test("uvarint and cidLen stop cleanly on a short buffer", () => {
  assert.equal(uvarint(Buffer.from([0x80]), 0), null);          // mid-varint
  assert.deepEqual(uvarint(Buffer.from([0xac, 0x02]), 0), [300, 2]);
  const cid = rawCid(Buffer.from("x"));
  assert.equal(cidLen(cid, 0), 36);
  assert.equal(cidLen(cid.subarray(0, 10), 0), null);           // truncated CID
});

test("a header-only CAR naming the root is NOT the root", async () => {
  const cid = rawCid(Buffer.from("bytes the gateway lost"));
  const car = headerOnlyCar(cid);
  assert.equal(car.length, 59, "kubo's empty CAR is 59 bytes; the fixture must match it");
  assert.ok(car.includes(cid), "the header does carry the CID — that is the trap");
  const r = await carHasRoot(streamOf(car), cid);
  assert.equal(r.found, false);
  assert.equal(r.total, 59);
});

test("a CAR carrying the root block is a hit", async () => {
  const data = Buffer.from("the actual wasm");
  const cid = rawCid(data);
  const car = Buffer.concat([headerOnlyCar(cid), blockEntry(cid, data)]);
  assert.equal((await carHasRoot(streamOf(car), cid)).found, true);
});

test("the root is found when it is not the first block", async () => {
  const other = Buffer.alloc(300_000, 7);          // a chunk big enough to span reads
  const data = Buffer.from("root arrives late");
  const cid = rawCid(data);
  const car = Buffer.concat([
    headerOnlyCar(cid), blockEntry(rawCid(other), other), blockEntry(cid, data)]);
  assert.equal((await carHasRoot(streamOf(car), cid)).found, true);
});

test("frames split across arbitrary chunk boundaries still parse", async () => {
  const other = Buffer.alloc(1000, 3);
  const data = Buffer.from("root arrives late");
  const cid = rawCid(data);
  const car = Buffer.concat([
    headerOnlyCar(cid), blockEntry(rawCid(other), other), blockEntry(cid, data)]);
  for (const size of [1, 2, 7, 58, 59, 60, 61, 97, 1023, 1037]) {
    const r = await carHasRoot(streamOf(car, size), cid);
    assert.equal(r.found, true, `chunk size ${size}`);
  }
});

test("a CAR of unrelated blocks is a miss, not a hit", async () => {
  const cid = rawCid(Buffer.from("wanted"));
  const junk = Buffer.alloc(500, 1);
  const car = Buffer.concat([headerOnlyCar(cid), blockEntry(rawCid(junk), junk)]);
  assert.equal((await carHasRoot(streamOf(car), cid)).found, false);
});
