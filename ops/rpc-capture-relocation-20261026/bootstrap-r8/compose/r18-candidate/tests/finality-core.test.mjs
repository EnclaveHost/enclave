// finality-core adversarial tests (PREPARED; NOT run by Claude: root's jobs/root-finality-tests.sh runs them, exact count 20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { qualify, VERDICT, FinalityRefusal, FinalityContradiction } from "../src/finality-core.mjs";
import { keccak, makeChain, outputRootOf, rpcOver, header } from "./helpers/chain.mjs";

const N = 1000, NP = 1137;                      // launch anchor N and a fresh anchor N' (span 137: crosses chunk edges)
const chain = makeChain(N - 3, NP + 5);
const original = { N, blockHash: chain.get(N).hash, outputRoot: outputRootOf(chain.get(N)) };
const fresh = { N: NP, outputRoot: outputRootOf(chain.get(NP)) };
const run = (args = {}, io = rpcOver(chain), chunk = 16) => qualify({ original, fresh, prior: [], ...args }, io, { keccak, chunk });
const refusal = (code) => (e) => { assert.ok(e instanceof FinalityRefusal, `expected refusal ${code}, got ${e?.constructor?.name} ${e?.code}`); assert.equal(e.code, code); return true; };
const contradiction = (code) => (e) => { assert.ok(e instanceof FinalityContradiction, `expected contradiction ${code}, got ${e?.constructor?.name} ${e?.code}: ${e?.message}`); assert.equal(e.code, code); return true; };

test("qualifies: fresh N' authenticated by its own output root, ancestry walked down to the ORIGINAL N", async () => {
  for (const chunk of [2, 16, 137, 138, 4096]) {
    const r = await run({}, rpcOver(chain), chunk);
    assert.equal(r.verdict, VERDICT); assert.equal(r.span, NP - N);
    assert.equal(r.original.blockHash, original.blockHash); assert.equal(r.fresh.blockHash, chain.get(NP).hash);
  }
});
test("reads ONLY explicit numbers in [N, N'] plus the chain id: never a label, never above N', never below N", async () => {
  const io = rpcOver(chain); await run({}, io);
  for (const [m, sel] of io.log) {
    if (m === "eth_chainId") continue;
    assert.equal(m, "eth_getBlockByNumber"); assert.match(sel, /^0x[0-9a-f]+$/);
    const n = Number(BigInt(sel)); assert.ok(n >= N && n <= NP, `read ${n}`);
  }
});
test("no proof: a fresh anchor not above N is refused (nothing above N is ever qualified from N itself)", async () => {
  await assert.rejects(run({ fresh: { N, outputRoot: original.outputRoot } }), refusal("not_post_anchor"));
  await assert.rejects(run({ fresh: { N: N - 1, outputRoot: original.outputRoot } }), refusal("not_post_anchor"));
});
test("stale/replayed proof: a fresh anchor not above an already qualified point is refused", async () => {
  await assert.rejects(run({ prior: [{ N: NP, blockHash: chain.get(NP).hash }] }), refusal("not_newer"));
  await assert.rejects(run({ prior: [{ N: NP + 1, blockHash: chain.get(NP + 1).hash }] }), refusal("not_newer"));
});
test("wrong chain: chain id other than 8453 refuses before any header read", async () => {
  const io = rpcOver(chain, { chainId: "0xa" });
  await assert.rejects(run({}, io), refusal("wrong_chain"));
  assert.deepEqual(io.log, [["eth_chainId"]]);
});
test("wrong root: our header N' does not reproduce the fresh A1 output root -> contradiction", async () => {
  await assert.rejects(run({ fresh: { N: NP, outputRoot: outputRootOf(chain.get(NP - 1)) } }), contradiction("fresh_anchor:output_root"));   // the root of another block
  await assert.rejects(run({ fresh: { N: NP, outputRoot: "0x" + "11".repeat(32) } }), contradiction("fresh_anchor:output_root"));
});
test("our node on a FORK above N (self-consistent, different state): the fresh root is not reproduced -> contradiction", async () => {
  const forked = makeChain(N - 3, NP + 5, { fork: { at: N + 50, salt: "x" } });
  const f = new Map([...forked].map(([n, h]) => [n, n < N + 50 ? chain.get(n) : h]));
  await assert.rejects(run({}, rpcOver(f)), contradiction("fresh_anchor:output_root"));
});
test("broken ancestry: one tampered middle header (re-hashed) breaks the parent link -> contradiction", async () => {
  const bad = { ...chain.get(N + 70), stateRoot: "0x" + "22".repeat(32) }; delete bad.hash;
  await assert.rejects(run({}, rpcOver(chain, { at: { [N + 70]: bad } })), contradiction("ancestry:unlinked"));
});
test("a header whose claimed `hash` field lies -> contradiction (hash claims are never used)", async () => {
  const lie = { ...chain.get(N + 30), hash: "0x" + "33".repeat(32) };
  await assert.rejects(run({}, rpcOver(chain, { at: { [N + 30]: lie } })), contradiction("ancestry:hash_claim"));
});
test("the node answers a different block for a number -> contradiction (discontinuity)", async () => {
  await assert.rejects(run({}, rpcOver(chain, { at: { [N + 40]: { ...chain.get(N + 41) } } })), contradiction("ancestry:discontinuity"));
});
test("wrong original anchor: the path to N' reaches N with another hash than the launch record -> contradiction", async () => {
  const other = { ...original, blockHash: "0x" + "44".repeat(32) };
  await assert.rejects(run({ original: other }), contradiction("original_anchor_not_ancestor"));
  // a DB whose block N differs (e.g. another snapshot) but whose N..N' is internally linked: N does not reproduce the ORIGINAL root
  const db = makeChain(N - 3, NP + 5, { fork: { at: N, salt: "db" } });
  const dbFresh = { N: NP, outputRoot: outputRootOf(db.get(NP)) };
  await assert.rejects(run({ fresh: dbFresh }, rpcOver(db)), contradiction("original_anchor:output_root"));
});
test("launch record internally inconsistent (anchor hash vs original root) -> contradiction, never qualified", async () => {
  await assert.rejects(run({ original: { ...original, outputRoot: outputRootOf(chain.get(N + 1)) } }), contradiction("original_anchor:output_root"));
});
test("a previously qualified point no longer on the path (reorg / DB swap after restart) -> contradiction", async () => {
  await assert.rejects(run({ prior: [{ N: N + 60, blockHash: "0x" + "55".repeat(32) }] }), contradiction("prior_qualified_not_ancestor"));
  const ok = await run({ prior: [{ N: N + 60, blockHash: chain.get(N + 60).hash }] });
  assert.deepEqual(ok.priorChecked, [N + 60]);
});
test("not synced: the node lacks N' -> refusal (no state change), and lacks a middle block -> refusal", async () => {
  await assert.rejects(run({}, rpcOver(chain, { at: { [NP]: null } })), refusal("not_synced"));
  await assert.rejects(run({}, rpcOver(chain, { at: { [N + 5]: null } })), refusal("not_synced"));
});
test("an RPC failure is a refusal, never a pass", async () => {
  const io = { l2: async (m) => { if (m === "eth_chainId") return "0x2105"; throw new Error("boom"); } };
  await assert.rejects(run({}, io), refusal("rpc_failed"));
});
test("a non-Isthmus fresh header (missing requestsHash) is malformed input -> refusal", async () => {
  const h = { ...chain.get(NP) }; delete h.requestsHash; delete h.hash;
  await assert.rejects(run({}, rpcOver(chain, { at: { [NP]: h } })), refusal("fresh_anchor:not_isthmus"));
});
test("span above MAX_SPAN refuses without reading", async () => {
  const io = rpcOver(chain);
  await assert.rejects(run({ fresh: { N: N + 4_000_001, outputRoot: fresh.outputRoot } }, io), refusal("span_too_long"));
  assert.equal(io.log.length, 0);
});
test("malformed inputs refuse (no default, no coercion)", async () => {
  await assert.rejects(run({ original: { ...original, N: "1000" } }), refusal("bad_input"));
  await assert.rejects(run({ fresh: { N: NP, outputRoot: "0x12" } }), refusal("bad_input"));
  await assert.rejects(run({ prior: "x" }), refusal("bad_input"));
  await assert.rejects(qualify({ original, fresh }, rpcOver(chain), { keccak, chunk: 1 }), refusal("bad_input"));
});
test("the vendor module is used unchanged: a header N' from a NEWER block than N' (descendant) cannot stand in for N'", async () => {
  await assert.rejects(run({}, rpcOver(chain, { at: { [NP]: { ...chain.get(NP + 1) } } })), contradiction("fresh_anchor:anchor_number"));
});
test("the synthetic header helper matches the vendor hashing (guards the fixture itself)", async () => {
  const h = header(5, "0x" + "00".repeat(32));
  assert.notEqual(outputRootOf(h), outputRootOf({ ...h, stateRoot: "0x" + "01".repeat(32) }));
});
