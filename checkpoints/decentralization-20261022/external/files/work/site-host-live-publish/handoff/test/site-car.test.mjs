// Finding 3: the CAR header must be exactly the canonical one-root CARv1 header; malformed or oversized varints are
// bounded refusals; the per-block exact-set and hash checks are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { cidParse } from "../../../enclave/scripts/site-release/unixfs.mjs";
import { verifyCar, carHeaderOf, UploadRefusal } from "../site-upload.mjs";
import { FROZEN, GOOD_CAR, fixture, varint } from "./site-harness.mjs";

test("CAR: only the exact canonical {roots: [expected CID], version: 1} header passes; malformed headers and varints are bounded refusals", () => {
  const fx = fixture(), t = fx.t, dag = FROZEN.dag;
  const H = carHeaderOf(t.expectedCid);
  // the header is refused before any block is read, so each bad case carries the real first block section (a few
  // hundred KiB) rather than a copy of all 46 MB; the cases are built one at a time
  const tail = GOOD_CAR.subarray(1 + H.length);
  let n = 0, k = 0; do { n += (tail[k] & 127) * 128 ** k; } while (tail[k++] & 128);
  const blocks = tail.subarray(0, k + n);   // the first block section, intact
  assert.equal(H.length, 58); assert.ok(GOOD_CAR.subarray(0, 59).equals(Buffer.concat([varint(58), H])), "the fixture CAR starts with the canonical header");
  assert.equal(verifyCar(t, GOOD_CAR, dag).blocks, new Set(dag.blocks.map(([k]) => Buffer.from(k).toString("hex"))).size, "the canonical CAR still passes (per-block exact set and hashes unchanged)");
  const c = cidParse(t.expectedCid), link = (x) => Buffer.concat([Buffer.from([0xd8, 0x2a, 0x58, x.length + 1, 0]), x]);
  const s = (x) => Buffer.concat([Buffer.from([0x60 + x.length]), Buffer.from(x)]);
  const withHeader = (h, rest = blocks) => Buffer.concat([varint(h.length), h, rest]);
  const other = cidParse("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
  const HEADER = /the CAR header is not exactly/;
  const cases = [
    ["version 2", () => withHeader(Buffer.concat([H.subarray(0, -1), Buffer.from([2])])), HEADER],
    ["version as a string", () => withHeader(Buffer.concat([H.subarray(0, -1), s("1")])), HEADER],
    ["two roots", () => withHeader(Buffer.concat([Buffer.from([0xa2]), s("roots"), Buffer.from([0x82]), link(c), link(c), s("version"), Buffer.from([1])])), HEADER],
    ["no roots", () => withHeader(Buffer.concat([Buffer.from([0xa2]), s("roots"), Buffer.from([0x80]), s("version"), Buffer.from([1])])), HEADER],
    ["roots not an array", () => withHeader(Buffer.concat([Buffer.from([0xa2]), s("roots"), link(c), s("version"), Buffer.from([1])])), HEADER],
    ["an unknown header key", () => withHeader(Buffer.concat([Buffer.from([0xa3]), s("x"), Buffer.from([1]), s("roots"), Buffer.from([0x81]), link(c), s("version"), Buffer.from([1])])), HEADER],
    ["keys out of canonical order", () => withHeader(Buffer.concat([Buffer.from([0xa2]), s("version"), Buffer.from([1]), s("roots"), Buffer.from([0x81]), link(c)])), HEADER],
    ["another root", () => withHeader(Buffer.concat([Buffer.from([0xa2]), s("roots"), Buffer.from([0x81]), link(other), s("version"), Buffer.from([1])])), HEADER],
    ["a CARv2 pragma", () => Buffer.concat([Buffer.from([0x0a, 0xa1]), s("version"), Buffer.from([2]), Buffer.alloc(40)]), HEADER],
    ["a header longer than the file", () => Buffer.concat([varint(58), H.subarray(0, 20)]), HEADER],
    ["an empty file", () => Buffer.alloc(0), /truncated CAR varint/],
    ["a truncated header varint", () => Buffer.from([0xba]), /truncated CAR varint/],
    ["an oversized header varint", () => Buffer.alloc(64, 0xff), /oversized CAR varint/],
    ["a non-minimal header varint", () => Buffer.concat([Buffer.from([0xba, 0x00]), H, blocks]), /non-minimal CAR varint/],
    ["a block length beyond the file", () => Buffer.concat([varint(58), H, varint(2 ** 34), Buffer.alloc(100)]), /truncated CAR block/],
    ["an oversized block varint", () => Buffer.concat([varint(58), H, Buffer.alloc(16, 0xff)]), /oversized CAR varint/],
    ["a truncated block varint", () => Buffer.concat([varint(58), H, Buffer.from([0x80])]), /truncated CAR varint/],
    ["a block shorter than its CID", () => Buffer.concat([varint(58), H, varint(10), Buffer.alloc(10)]), /truncated CAR block/],
  ];
  for (const [name, make, re] of cases) {
    const car = make(), t0 = process.hrtime.bigint();
    assert.ok(car.length < 1 << 20, name + ": a small input");
    assert.throws(() => verifyCar(t, car, dag), (e) => e instanceof UploadRefusal && re.test(e.message), name);
    assert.ok(process.hrtime.bigint() - t0 < 200_000_000n, name + ": refused within 200 ms");
  }
});
