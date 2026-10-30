// node --test test/anchor-bootstrap.test.mjs. keccak (@noble/hashes) and viem's toRlp (an INDEPENDENT RLP encoder) come from
// ./deps.mjs: resolved by package name from a source checkout (or ANCHOR_DEPS_ROOT), pinned to source/package-lock.json versions.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { keccak_256, toRlp, resolved, PINNED } from "./deps.mjs";
import { headerRlp, headerHash, outputRootV0, authenticateAnchor, authenticateAncestors, planBootstrap, checkRebuild, AnchorBootstrapError, toHex, quantityBytes } from "../anchor-bootstrap.mjs";

const k = (b) => keccak_256(b);
const h32 = (s) => toHex(k(new TextEncoder().encode(s)));
const code = (c) => (e) => e instanceof AnchorBootstrapError && e.code === c;
const EMPTY_REQUESTS = "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// Ethereum mainnet genesis: a published header whose hash everyone knows (pre-London: the 15 base fields).
const GENESIS = { parentHash: "0x" + "00".repeat(32), sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
  miner: "0x" + "00".repeat(20), stateRoot: "0xd7f8974fb5ac78d9ac099b9ad5018bedc2ce0a72dad1827a1709da30580f0544",
  transactionsRoot: "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421", receiptsRoot: "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
  logsBloom: "0x" + "00".repeat(256), difficulty: "0x400000000", number: "0x0", gasLimit: "0x1388", gasUsed: "0x0", timestamp: "0x0",
  extraData: "0x11bbe8db4e347b4e8c937c1c8370e4b5ed33adb3db69cbdb7a38e1e50b1b82fa", mixHash: "0x" + "00".repeat(32), nonce: "0x0000000000000042" };

// a Base-shaped (Isthmus) header
function isthmus(number, parentHash, salt = "") {
  return { parentHash, sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347", miner: "0x4200000000000000000000000000000000000011",
    stateRoot: h32(`state ${number}${salt}`), transactionsRoot: h32(`txs ${number}`), receiptsRoot: h32(`rcpt ${number}`), logsBloom: "0x" + "00".repeat(256),
    difficulty: "0x0", number: "0x" + number.toString(16), gasLimit: "0x8f0d180", gasUsed: "0x1c9c380", timestamp: "0x" + (1792886410 + 2 * (number - 53048526)).toString(16),
    extraData: "0x00000000fa00000006", mixHash: h32(`prevrandao ${number}`), nonce: "0x0000000000000000", baseFeePerGas: "0x5f5e1",
    withdrawalsRoot: h32(`message passer ${number}${salt}`), blobGasUsed: "0x0", excessBlobGas: "0x0", parentBeaconBlockRoot: h32(`beacon ${number}`), requestsHash: EMPTY_REQUESTS };
}
function chain(from, n) {
  const out = []; let parent = h32("parent of " + from);
  for (let i = 0; i < n; i++) { const h = isthmus(from + i, parent); h.hash = headerHash(h, k); out.push(h); parent = h.hash; }
  return out;
}
const gameFor = (h) => ({ rootClaim: outputRootV0({ stateRoot: h.stateRoot, messagePasserStorageRoot: h.withdrawalsRoot, blockHash: headerHash(h, k) }, k), l2BlockNumber: Number(h.number) });

test("RLP and header hash: the published mainnet genesis hash, and byte-equality with viem's independent toRlp", () => {
  assert.equal(headerHash(GENESIS, k), "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3");
  const h = isthmus(53048526, h32("p"));
  const viemFields = [h.parentHash, h.sha3Uncles, h.miner, h.stateRoot, h.transactionsRoot, h.receiptsRoot, h.logsBloom, ...["difficulty", "number", "gasLimit", "gasUsed", "timestamp"].map((f) => toHex(quantityBytes(h[f]))),
    h.extraData, h.mixHash, h.nonce, toHex(quantityBytes(h.baseFeePerGas)), h.withdrawalsRoot, toHex(quantityBytes(h.blobGasUsed)), toHex(quantityBytes(h.excessBlobGas)), h.parentBeaconBlockRoot, h.requestsHash]
    .map((x) => (x === "0x" ? "0x" : x));
  assert.equal(toHex(headerRlp(h, { requireIsthmus: true })), toRlp(viemFields));
  // a fork field without the earlier ones is refused, never silently encoded
  assert.throws(() => headerRlp({ ...GENESIS, withdrawalsRoot: h32("x") }), code("bad_input"));
});

test("anchor header N authenticates against the game's output root; every forged field is refused", () => {
  const [h] = chain(53048000, 1), g = gameFor(h);
  const a = authenticateAnchor(g, h, k);
  assert.deepEqual({ ...a }, { number: 53048000, stateRoot: h.stateRoot, messagePasserStorageRoot: h.withdrawalsRoot, blockHash: headerHash(h, k) });
  assert.throws(() => authenticateAnchor(g, { ...h, stateRoot: h32("forged state"), hash: undefined }, k), code("output_root"));
  assert.throws(() => authenticateAnchor(g, { ...h, withdrawalsRoot: h32("forged mp"), hash: undefined }, k), code("output_root"));
  assert.throws(() => authenticateAnchor(g, { ...h, gasUsed: "0x1", hash: undefined }, k), code("output_root"), "any header field change changes blockHash");
  assert.throws(() => authenticateAnchor(g, { ...h, hash: h32("lie") }, k), code("hash_claim"), "a claimed hash is never used");
  assert.throws(() => authenticateAnchor({ ...g, l2BlockNumber: 53048001 }, h, k), code("anchor_number"));
  const { requestsHash, ...pre } = h;
  assert.throws(() => authenticateAnchor(g, { ...pre, hash: undefined }, k), code("not_isthmus"));
});

test("ancestors only: a range ending at N authenticates; a snapshot head ABOVE N (invented descendants) never does", () => {
  const hs = chain(53047990, 11), N = hs[10];
  const a = authenticateAnchor(gameFor(N), N, k);
  const m = authenticateAncestors(hs, a, k);
  assert.equal(m.size, 11); assert.equal(m.get(53047990).hash, hs[0].hash);
  // root's issue: anchor below the snapshot head. A malicious DB extends N with invented, perfectly linked descendants.
  const forged = [...hs]; let parent = N.hash;
  for (let i = 1; i <= 5; i++) { const d = isthmus(53048000 + i, parent, " invented"); d.hash = headerHash(d, k); forged.push(d); parent = d.hash; }
  assert.throws(() => authenticateAncestors(forged, a, k), code("descendant"));
  // a tampered ancestor whose stored `hash` still "links": the recomputed hash breaks the link
  const t = hs.map((h) => ({ ...h })); t[4].receiptsRoot = h32("forged receipts");
  assert.throws(() => authenticateAncestors(t, a, k), code("hash_claim"));
  delete t[4].hash;
  assert.throws(() => authenticateAncestors(t, a, k), code("unlinked"));
  // a gap
  assert.throws(() => authenticateAncestors([hs[0], ...hs.slice(2)], a, k), code("discontinuity"));
});

test("planBootstrap: never accepts the snapshot head above N; unwinds to N, syncs past N, or waits when history is gone", () => {
  const A = { number: 52746000 };
  const u = planBootstrap({ anchor: A, localHead: 53048526, changesetFloor: 52500000 });
  assert.equal(u.action, "unwind_to_anchor"); assert.equal(u.authenticatedThrough, null);
  assert.match(u.reason, /52746001\.\.53048526 are unauthenticated/); assert.ok(u.steps.some((s) => /unwind to exactly 52746000/.test(s)));
  const w = planBootstrap({ anchor: A, localHead: 53300000, changesetFloor: 53000000 });
  assert.equal(w.action, "wait_for_newer_anchor"); assert.match(w.steps[0], /HOLD the changeset floor/);
  const s = planBootstrap({ anchor: { number: 53100000 }, localHead: 53048526, changesetFloor: 52500000 });
  assert.equal(s.action, "sync_past_anchor_then_unwind"); assert.ok(s.steps.some((x) => /unwind to exactly 53100000/.test(x)));
  assert.equal(planBootstrap({ anchor: { number: 53048526 }, localHead: 53048526, changesetFloor: 52500000 }).action, "rebuild_at_anchor");
  for (const p of [u, s]) assert.ok(p.steps.some((x) => /refuse historical-state queries below/.test(x)) && p.steps.some((x) => /safe-head/.test(x)));
});

test("checkRebuild: only a rebuild at exactly N with N's state root verifies state (flaw 2: a rebuild at a later tip proves nothing)", () => {
  const [h] = chain(53048000, 1), a = authenticateAnchor(gameFor(h), h, k);
  assert.deepEqual({ ...checkRebuild(a, { block: 53048000, stateRoot: h.stateRoot }) }, { verifiedStateAt: 53048000, stateRoot: h.stateRoot, blockHash: a.blockHash });
  assert.throws(() => checkRebuild(a, { block: 53048526, stateRoot: h32("our own tip header's root") }), code("rebuild_height"));
  assert.throws(() => checkRebuild(a, { block: 53048000, stateRoot: h32("other") }), code("rebuild_root"));
  assert.throws(() => checkRebuild({ number: 1 }, { block: 1, stateRoot: h.stateRoot }), code("no_anchor"));
});

test("dependencies are the pinned package versions, resolved by name (never a sibling tree path)", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, v.version])), { ...PINNED });
  // resolved through the dependency root's OWN node_modules (realpath: a checkout may symlink its install), never a sibling path
  for (const v of Object.values(resolved)) assert.ok(v.nodeModules && v.realDir.startsWith(v.nodeModules + path.sep), JSON.stringify(v));
  console.log("# deps " + JSON.stringify(resolved));
});
