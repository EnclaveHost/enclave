// Run with node --test after installing this repository's pinned @noble/hashes dependency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bloomOf, bloomMayContain, mayHoldLeaseLog, planCompleteScan, assembleCompleteLogs, outputRootV0, anchorFromOutputRoot, hexBytes, CompleteLogsError } from "../complete-logs.mjs";

const k = (b) => keccak_256(b);
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const h32 = (s) => hex(k(new TextEncoder().encode(s)));
const LEDGER = "0x" + "ab".repeat(20), ID = h32("deployment"), OTHER = h32("other");
const CLAIMED = "0xa8cc21eb0ec0b0b7328426babbe37866c627edfd2ae57aeaed4f54abc0534bc0";
const RENEWED = "0xc3f167f2092d6942fb4264b1759de5eda7eedc20287375c9eddd62e98a560b3e";
const RELEASED = "0x0e334fd11ab7bea6d2bda89338c0f25674e099b70dd28aaaee262fbecba48882";
const F = { ledger: LEDGER, id: ID, topic0s: [CLAIMED, RENEWED, RELEASED] };
const EMPTY = "0x" + "00".repeat(256);
const code = (c) => (e) => e instanceof CompleteLogsError && e.code === c;
const leaseBloom = (t0, id = ID) => bloomOf([hexBytes(LEDGER, 20), hexBytes(t0, 32), hexBytes(id, 32)], k);

// a linked chain of n headers from `from`; blooms[i] per header (default empty)
function chain(from, n, blooms = {}) {
  const out = [];
  let parent = h32("genesis");
  for (let i = 0; i < n; i++) {
    const number = from + i, hash = h32(`block${number}`);
    out.push({ number, hash, parentHash: parent, receiptsRoot: h32(`rr${number}`), logsBloom: blooms[i] || EMPTY });
    parent = hash;
  }
  return out;
}

test("bloom: the yellow-paper bit positions, checked independently", () => {
  const v = hexBytes(LEDGER, 20), d = k(v), bloom = Buffer.from(bloomOf([v], k).slice(2), "hex");
  for (const i of [0, 2, 4]) { const bit = ((d[i] << 8) | d[i + 1]) % 2048; assert.ok(bloom[255 - Math.floor(bit / 8)] & (1 << (bit % 8))); }
  assert.equal(bloom.reduce((n, b) => n + [...b.toString(2)].filter((c) => c === "1").length, 0) <= 3, true);
  assert.equal(bloomMayContain(EMPTY, v, k), false);
  assert.equal(bloomMayContain(bloomOf([v], k), v, k), true);
});

test("mayHoldLeaseLog needs address, id and one lease topic0", () => {
  assert.equal(mayHoldLeaseLog(leaseBloom(CLAIMED), F, k), true);
  assert.equal(mayHoldLeaseLog(leaseBloom(RENEWED), F, k), true);
  assert.equal(mayHoldLeaseLog(bloomOf([hexBytes(LEDGER, 20), hexBytes(ID, 32)], k), F, k), false);       // no lease topic0
  assert.equal(mayHoldLeaseLog(bloomOf([hexBytes(LEDGER, 20), hexBytes(CLAIMED, 32)], k), F, k), false);  // no id
  assert.equal(mayHoldLeaseLog(bloomOf([hexBytes(CLAIMED, 32), hexBytes(ID, 32)], k), F, k), false);      // no ledger
});

test("plan: candidates are exactly the bloom-positive blocks of a linked range ending at the anchor", () => {
  const hs = chain(100, 6, { 1: leaseBloom(CLAIMED), 4: leaseBloom(RENEWED), 3: leaseBloom(CLAIMED, OTHER) });
  const p = planCompleteScan(hs, { number: 105, blockHash: hs[5].hash }, F, k);
  assert.deepEqual(p.candidates.map((c) => c.number), [101, 104]);
  assert.equal(p.skipped, 4); assert.equal(p.lo, 100); assert.equal(p.hi, 105);
});

test("plan refuses: no anchor, wrong anchor, a gap, a broken link, a malformed header", () => {
  const hs = chain(100, 4);
  assert.throws(() => planCompleteScan(hs, undefined, F, k), code("no_anchor"));
  assert.throws(() => planCompleteScan(hs, { number: 103, blockHash: h32("forged") }, F, k), code("anchor_mismatch"));
  assert.throws(() => planCompleteScan(hs, { number: 104, blockHash: hs[3].hash }, F, k), code("anchor_mismatch"));
  const gap = [...hs.slice(0, 2), ...hs.slice(3)];
  assert.throws(() => planCompleteScan(gap, { number: 103, blockHash: hs[3].hash }, F, k), code("discontinuity"));
  const swapped = hs.map((h) => ({ ...h })); swapped[2].parentHash = h32("fork");
  assert.throws(() => planCompleteScan(swapped, { number: 103, blockHash: hs[3].hash }, F, k), code("unlinked"));
  const bad = hs.map((h) => ({ ...h })); bad[1].receiptsRoot = "0x12";
  assert.throws(() => planCompleteScan(bad, { number: 103, blockHash: hs[3].hash }, F, k), code("bad_input"));
});

test("assemble: every candidate's receipts must be present with the header's receiptsRoot", () => {
  const hs = chain(100, 3, { 0: leaseBloom(CLAIMED), 2: leaseBloom(RENEWED) });
  const p = planCompleteScan(hs, { number: 102, blockHash: hs[2].hash }, F, k);
  const log = (h, i, t0, id = ID, address = LEDGER) => ({ blockNumber: h.number, blockHash: h.hash, logIndex: i, address, topics: [t0, id], data: "0x" });
  const good = new Map([
    [hs[0].hash, { receiptsRoot: hs[0].receiptsRoot, logs: [log(hs[0], 3, CLAIMED), log(hs[0], 1, CLAIMED, OTHER)] }],
    [hs[2].hash, { receiptsRoot: hs[2].receiptsRoot, logs: [log(hs[2], 0, RENEWED), log(hs[2], 1, RENEWED, ID, "0x" + "cd".repeat(20))] }],
  ]);
  assert.deepEqual(assembleCompleteLogs(p, good, F).map((l) => [l.blockNumber, l.logIndex]), [[100, 3], [102, 0]]);
  const missing = new Map([...good].slice(0, 1));
  assert.throws(() => assembleCompleteLogs(p, missing, F), code("incomplete"));            // an omitted block is never empty history
  const wrongRoot = new Map(good); wrongRoot.set(hs[2].hash, { ...good.get(hs[2].hash), receiptsRoot: h32("x") });
  assert.throws(() => assembleCompleteLogs(p, wrongRoot, F), code("receipts_root"));
  const moved = new Map(good); moved.set(hs[2].hash, { receiptsRoot: hs[2].receiptsRoot, logs: [log(hs[0], 0, RENEWED)] });
  assert.throws(() => assembleCompleteLogs(p, moved, F), code("bad_input"));
});

test("output root v0 and the anchor it yields", () => {
  const pre = { stateRoot: h32("s"), bridgeStorageRoot: h32("w"), blockHash: h32("b") };
  const enc = Buffer.concat([Buffer.alloc(32), ...[pre.stateRoot, pre.bridgeStorageRoot, pre.blockHash].map((x) => Buffer.from(x.slice(2), "hex"))]);
  const root = hex(k(enc));
  assert.equal(outputRootV0(pre, k), root);
  assert.deepEqual(anchorFromOutputRoot(root, 7, pre, k), { number: 7, blockHash: pre.blockHash });
  assert.throws(() => anchorFromOutputRoot(root, 7, { ...pre, blockHash: h32("other") }, k), code("output_root"));
  assert.throws(() => anchorFromOutputRoot(root, 0, pre, k), code("bad_input"));
});
