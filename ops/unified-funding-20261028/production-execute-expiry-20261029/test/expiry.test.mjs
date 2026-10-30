// UNREVIEWED, NOT RUN. execute-expiry-recovery-r1: the expired-unused chain proof and the user-requested same-nonce
// re-admission. Real WebCrypto P-256 keys/signatures, the canonical codec / MemoryV2Store / relayClient / receipt proofs;
// SCRIPTED chain (test/exec-fixtures.mjs chain() + the wrapper below for eth_chainId, eth_getCode, seqOf and header
// tampering) and SCRIPTED relay. No network, wallet, funds or IndexedDB.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, toHex } from "../../../source/node_modules/viem/_esm/index.js";
import { buildGasFundCall } from "../../../source/sdk/funding/funding-codec.mjs";
import { MemoryV2Store } from "../../../source/sdk/funding/v2-store.mjs";
import { relayClient } from "../../../source/sdk/funding/funding-client.mjs";
import { hashOf, lower } from "../../../source/sdk/funding/util.mjs";
import * as EX from "../sdk/funding/gas-execution.mjs";
import * as ENTRY from "../sdk/funding/browser-entry.mjs";
import { A, DEP, IMPL, IMPL_CODE, INTENT, NOW, RELAY_BASE, TX, cfg, code, countingSubtle, relayFor, reviewFor, runtime, setup } from "./exec-fixtures.mjs";

const SEQ_ABI = [{ type: "function", name: "seqOf", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }, { name: "", type: "uint192" }],
  outputs: [{ name: "", type: "uint64" }] }];
const clone = (impl) => `0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
const ZERO32 = `0x${"0".repeat(64)}`;
const SECRETS = ["privateKey", "\"r\"", "\"s\"", "\"sig\"", "signature"];
/** The production answer: the host quote policy refused the envelope BEFORE intentSubmit / TxQueue, as a 503. */
const POLICY_503 = { code: "quote_policy_failed", error: "host quote policy(envelope) gas_above_cap needs 1051860 > 1000000" };

/** Wraps the scripted chain: eth_chainId, eth_getCode (vault clone / implementation), vault.seqOf(sid, lane) per lane,
 *  per-block timestamp overrides, and hooks that bend the finalized / numbered headers or reorg while seqOf is read. */
function expiryChain(W) {
  const X = { chainId: "0x2105", ts: new Map(), seq: new Map(), seqCalls: [], tags: [], codeTags: [], vaultCode: clone(IMPL), implCode: IMPL_CODE,
    patchFinalized: null, patchNumbered: null, onSeq: null, seqRaw: undefined };
  const blockAt = (n) => { const b = W.block(n); return X.ts.has(BigInt(n)) ? { ...b, timestamp: toHex(X.ts.get(BigInt(n))) } : b; };
  X.rpc = async (method, params = []) => {
    if (method === "eth_chainId") return X.chainId;
    if (method === "eth_getBlockByNumber") {
      const t = params[0];
      X.tags.push(t);
      const n = t === "latest" ? W.head : t === "finalized" ? W.finalized : (t === "pending" || t === "safe" || t === "earliest") ? null : BigInt(t);
      if (n === null || n > W.head || n <= 0n) return null;
      let b = blockAt(n);
      if (t === "finalized" && X.patchFinalized) b = X.patchFinalized(b);
      if (t !== "finalized" && t !== "latest" && X.patchNumbered) b = X.patchNumbered(b, n);
      return b;
    }
    if (method === "eth_getCode") {
      X.codeTags.push(params[1]);
      const a = lower(params[0]);
      return a === lower(cfg.vault) ? X.vaultCode : a === lower(IMPL) ? X.implCode : "0x";
    }
    if (method === "eth_call") {
      const [sid, lane] = decodeFunctionData({ abi: SEQ_ABI, data: params[0].data }).args;
      X.seqCalls.push({ to: lower(params[0].to), sid: lower(sid), lane, tag: params[1] });
      if (X.onSeq) X.onSeq();
      if (X.seqRaw !== undefined) return X.seqRaw;
      return toHex(X.seq.get(`${lower(sid)}:${lane}`) ?? 0n, { size: 32 });
    }
    return W.rpc(method, params);
  };
  return X;
}
const key = (x, lane) => `${lower(x.record.sid)}:${lane}`;

function relay503() {
  const R = { posts: 0 };
  R.relay = relayClient(RELAY_BASE, async (_url, init) => {
    if (init.method === "GET") return { status: 200, ok: true, text: async () => JSON.stringify({ ops: [] }) };
    R.posts += 1;
    return { status: 503, ok: false, text: async () => JSON.stringify(POLICY_503) };
  });
  return R;
}
function reviewAt(record, now, { seq = 0n, fee = 25_000n, deadline = now + 300n, maxUsdcIn6 = INTENT.maxUsdcIn6 } = {}) {
  const nonce = (1n << 64n) | seq;
  const intent = { payer: cfg.vault, deployment: DEP, expectedOwner: cfg.legacyVault, ethOut: INTENT.ethOut, maxUsdcIn6, fee: INTENT.fee, deadline };
  const call = buildGasFundCall(cfg, { domainVersion: "2", now, sessionId: record.sid, nonce, action: 10, intent, fee, deadline });
  return { call, sid: record.sid, deployment: DEP, holder: cfg.legacyVault, env: 2,
    totals: { maxUsdcIn6, fee6: fee, totalMaximum6: maxUsdcIn6 + fee, balance6: 1_000_000n } };
}
/** First production-shaped attempt: signed, dispatched, answered 503 quote_policy_failed -> UNKNOWN. */
async function refusedFirst({ seq = 0n } = {}) {
  const t = await setup();
  const X = expiryChain(t.W);
  const R = relay503();
  const sub = countingSubtle();
  const review = reviewFor(t.record, { seq });
  await assert.rejects(EX.confirmGasFund({ runtime, store: t.store, record: t.record, review, relay: R.relay, relayBase: RELAY_BASE,
    rpc: X.rpc, now: NOW, subtle: sub }), code("quote_policy_failed"));
  const id = EX.execId(t.record.sid, review.call.execute.nonce);
  return { ...t, X, R, sub, review, id, entry: await t.store.getJournal(id) };
}
/** Chain time strictly past (extra > 0) or equal to (extra = 0) the CURRENT entry's deadline, finalized at the new head. */
async function expire(x, extra = 10n) {
  const e = await x.store.getJournal(x.id);
  x.W.mineEmpty(3);
  x.W.time = BigInt(e.call.deadline) + extra;
  x.W.finalized = x.W.head;
}
const rec = (x, over = {}) => EX.reconcileGasExecution({ runtime, store: x.store, rpc: x.X.rpc, relay: x.R.relay, relayBase: RELAY_BASE, id: x.id, ...over });
const blockers = async (x) => EX.executionBlockers(await x.store.listJournal(), x.record);
const confirmAt = (x, review, relay, subtle, now = x.W.time) => EX.confirmGasFund({ runtime, store: x.store, record: x.record, review, relay,
  relayBase: RELAY_BASE, rpc: x.X.rpc, now, subtle });
const reasonIs = (r) => (e) => e?.code === "expiry_not_proven" && e.detail?.reason === r;

test("production 503 quote_policy_failed is UNKNOWN and stays reserved until a finalized header passes the deadline", async () => {
  const x = await refusedFirst();
  assert.equal(x.entry.status, "unknown", "a 503 is never a proven refusal");
  assert.deepEqual([x.entry.outcome.status, x.entry.outcome.code], [503, "quote_policy_failed"]);
  assert.deepEqual([x.R.posts, x.sub.n], [1, 1]);
  const r = await rec(x);                                   // chain clock still at the quote time
  assert.deepEqual([r.verdict, r.status, r.observation.expiry.reason], ["unresolved", "unknown", "not_past_deadline"]);
  assert.equal((await blockers(x)).length, 1);
  const R2 = relayFor(x.W);
  await assert.rejects(confirmAt(x, reviewAt(x.record, NOW, { deadline: NOW + 301n }), R2.relay, countingSubtle(), NOW), code("unreconciled_execute"));
  assert.deepEqual([x.R.posts, R2.posts, x.sub.n], [1, 0, 1], "never resent, never re-signed");
});

test("valid expiry clears read-only: finalized header past BOTH deadlines, verified vault code, seqOf(sid, lane) unconsumed", async () => {
  const x = await refusedFirst();
  const before = await x.store.getJournal(x.id);
  await expire(x);
  const r = await rec(x);
  assert.deepEqual([r.verdict, r.status], ["resolved", "expired_unused"]);
  const e = await x.store.getJournal(x.id);
  assert.equal(e.intentHash, before.intentHash, "the verified intent is untouched");
  for (const k of ["call", "maximum", "anchor", "runtime", "record", "relay", "relayer", "outcome", "hints"]) assert.deepEqual(e[k], before[k], k);
  assert.deepEqual(e.history.at(-1), { status: "unknown", evidence: null, why: "expired_unused_proven" });
  assert.equal(e.evidence.kind, "expired_unused");
  assert.deepEqual([e.evidence.chainId, e.evidence.block, e.evidence.blockHash], ["8453", String(x.W.finalized), x.W.hash(x.W.finalized)]);
  assert.deepEqual([e.evidence.lane, e.evidence.seq, e.evidence.seqOf], ["1", "0", "0"]);
  assert.deepEqual([e.evidence.digest, e.evidence.intentHash], [before.call.digest, before.intentHash]);
  assert.ok(BigInt(e.evidence.timestamp) > BigInt(e.call.deadline) && BigInt(e.evidence.timestamp) > BigInt(e.call.intent.deadline));
  assert.deepEqual(await blockers(x), []);
  const v = EX.listGasExecutions(await x.store.listJournal(), x.record)[0];
  assert.deepEqual([v.status, v.blocking, v.funded], ["expired_unused", false, false]);
  const rev = e.rev;
  const again = await rec(x);                               // freshness re-check is read-only
  assert.deepEqual([again.verdict, again.status], ["resolved", "expired_unused"]);
  assert.equal((await x.store.getJournal(x.id)).rev, rev, "the recheck wrote nothing");
  for (const s of SECRETS) assert.equal(JSON.stringify(e).includes(s), false, s);
  assert.deepEqual([x.R.posts, x.sub.n], [1, 1], "no automatic POST and no signature");
});

test("the proof reads only the finalized header and that pinned number (never latest/pending/safe), at the correct lane", async () => {
  const x = await refusedFirst();
  await expire(x);
  x.X.seq.set(key(x, 0n), 9n);                               // another lane's counter is irrelevant
  x.X.tags.length = 0;
  const p = await EX.proveExpiredUnused(await x.store.getJournal(x.id), runtime, x.X.rpc);
  const tag = toHex(x.W.finalized);
  assert.equal(p.kind, "expired_unused");
  assert.ok(x.X.tags.includes("finalized"));
  assert.ok(x.X.tags.every((t) => !["latest", "pending", "safe", "earliest"].includes(t)), `tags ${x.X.tags}`);
  assert.deepEqual(x.X.seqCalls.map((c) => [c.to, c.sid, c.lane, c.tag]), [[lower(cfg.vault), lower(x.record.sid), 1n, tag]]);
  assert.ok(x.X.codeTags.length === 2 && x.X.codeTags.every((t) => t === tag));
  assert.deepEqual([p.lane, p.seq], ["1", "0"]);
  assert.deepEqual([x.R.posts, x.sub.n], [1, 1]);
});

const CASES = [
  ["wrong chain (RPC)", (x) => { x.X.chainId = "0x1"; }, "wrong_chain"],
  ["header NUMBER at the finalized height differs", (x) => { x.X.patchNumbered = (b, n) => (n === x.W.finalized ? { ...b, number: toHex(n + 1n) } : b); }, "header_number_mismatch"],
  ["header HASH at the finalized height differs", (x) => { x.X.patchFinalized = (b) => ({ ...b, hash: TX("5e") }); }, "header_hash_mismatch"],
  ["zero finalized hash", (x) => { x.X.patchFinalized = (b) => ({ ...b, hash: ZERO32 }); }, "header_zero"],
  ["zero finalized number", (x) => { x.X.patchFinalized = (b) => ({ ...b, number: "0x0" }); }, "header_zero"],
  ["non-canonical finalized number", (x) => { x.X.patchFinalized = (b) => ({ ...b, number: `0x0${b.number.slice(2)}` }); }, "header_malformed"],
  ["no finalized header at all", (x) => { x.W.finalized = 0n; }, "header_missing"],
  ["NOT FINALIZED past the deadline although latest is", (x) => { x.W.finalized = 100n; x.X.ts.set(100n, NOW); }, "not_past_deadline"],
  ["finalized timestamp EQUAL to the deadline (not strictly after)", "equal", "not_past_deadline"],
  ["nonce CONSUMED (seqOf = seq + 1)", (x) => { x.X.seq.set(key(x, 1n), 1n); }, "nonce_consumed"],
  ["OTHER LANE unused but own lane consumed", (x) => { x.X.seq.set(key(x, 0n), 0n); x.X.seq.set(key(x, 1n), 1n); }, "nonce_consumed"],
  ["vault code is the clone of another implementation", (x) => { x.X.vaultCode = clone(A("99")); }, "vault_code_mismatch"],
  ["implementation code differs from its verified pin", (x) => { x.X.implCode = "0x00"; }, "implementation_code_mismatch"],
  ["seqOf answer malformed", (x) => { x.X.seqRaw = "0x"; }, "seq_malformed"],
  ["REORG: the pinned header is replaced while it is read", (x) => { x.X.onSeq = () => x.W.reorg(x.W.finalized); }, "reorged"],
];
test("every missing / malformed / zero / non-canonical / inconsistent fact refuses; the entry stays unknown and reserved", async () => {
  for (const [name, bend, reason] of CASES) {
    const x = await refusedFirst();
    await expire(x, bend === "equal" ? 0n : 10n);
    if (typeof bend === "function") bend(x);
    const r = await rec(x);
    assert.deepEqual([r.verdict, r.status, r.observation?.expiry?.reason], ["unresolved", "unknown", reason], name);
    assert.equal((await blockers(x)).length, 1, name);
    assert.deepEqual([x.R.posts, x.sub.n], [1, 1], name);
  }
  const noPins = { ...runtime, pins: { usdc: runtime.pins.usdc, legacyFactory: runtime.pins.legacyFactory } };
  const y = await refusedFirst();
  await expire(y);
  assert.equal((await rec(y, { runtime: noPins })).observation.expiry.reason, "runtime_pins_missing");
  const z = await refusedFirst({ seq: 2n });                // stored seq 2, chain seqOf 1: not the stored sequence
  await expire(z);
  z.X.seq.set(key(z, 1n), 1n);
  assert.equal((await rec(z)).observation.expiry.reason, "seq_mismatch");
  const w = await refusedFirst();
  await expire(w);
  w.X.chainId = "0x1";
  await assert.rejects(EX.proveExpiredUnused(await w.store.getJournal(w.id), runtime, w.X.rpc), reasonIs("wrong_chain"));
});

test("reorg of a STORED proof: refused at admission (nothing written or sent); reconcile demotes it, keeps it in history, re-proves fresh", async () => {
  const x = await refusedFirst();
  await expire(x);
  await rec(x);
  const e = await x.store.getJournal(x.id);
  const F = BigInt(e.evidence.block);
  x.W.reorg(F);
  const R2 = relayFor(x.W);
  const sub = countingSubtle();
  await assert.rejects(confirmAt(x, reviewAt(x.record, x.W.time), R2.relay, sub), reasonIs("evidence_reorged"));
  assert.deepEqual(await x.store.getJournal(x.id), e, "nothing written");
  assert.deepEqual([R2.posts, sub.n], [0, 0]);
  const r = await rec(x);
  assert.equal(r.status, "expired_unused", "re-proven at the replacement finalized header");
  const after = await x.store.getJournal(x.id);
  assert.equal(after.evidence.blockHash, x.W.hash(F));
  assert.notEqual(after.evidence.blockHash, e.evidence.blockHash);
  assert.ok(after.history.some((h) => h.why === "expiry_evidence_reorged" && h.evidence?.blockHash === e.evidence.blockHash), "old proof retained");
  assert.equal(after.intentHash, e.intentHash);
});

test("user-requested new quote with the SAME nonce: fresh re-proof, CAS replacement, full predecessor kept, one POST, costs and grant unchanged", async () => {
  const x = await refusedFirst();
  await expire(x);
  await rec(x);
  const old = await x.store.getJournal(x.id);
  const grantBefore = (await x.store.loadKey(x.record.id)).grant;
  const R2 = relayFor(x.W, { mode: "ok" });
  const sub = countingSubtle();
  const review2 = reviewAt(x.record, x.W.time);
  assert.equal(review2.call.execute.nonce, x.review.call.execute.nonce, "same on-chain nonce");
  assert.notEqual(lower(review2.call.digest), old.call.digest, "a new signed digest");
  const out = await confirmAt(x, review2, R2.relay, sub);
  assert.deepEqual([R2.posts, sub.n, x.R.posts, x.sub.n], [1, 1, 1, 1], "exactly the one user-confirmed send");
  assert.equal(out.status, "observed");
  assert.equal(out.settlement.actual.totalDebit6, 65_000n);
  const e = await x.store.getJournal(x.id);
  assert.deepEqual([e.id, e.nonce, e.call.digest], [old.id, old.nonce, lower(review2.call.digest)]);
  assert.equal(e.predecessors.length, 1);
  const p = e.predecessors[0];
  const { predecessors: _a, predecessorsHash: _b, ...oldFull } = old;
  assert.deepEqual({ ...p, release: undefined }, { ...oldFull, release: undefined }, "the complete earlier public entry, verbatim");
  assert.deepEqual([p.release.kind, p.release.intentHash, p.release.digest], ["expired_unused", old.intentHash, old.call.digest]);
  assert.ok(BigInt(p.release.block) >= BigInt(old.evidence.block));
  assert.equal(e.predecessorsHash, hashOf(e.predecessors));
  assert.deepEqual(e.maximum, old.maximum, "same maximum");
  assert.deepEqual((await x.store.loadKey(x.record.id)).grant, grantBefore, "grant unchanged");
  for (const s of SECRETS) assert.equal(JSON.stringify(e).includes(s), false, s);
  x.W.mineEmpty(2);
  x.W.finalized = x.W.head;
  const r = await rec(x, { relay: R2.relay });
  assert.deepEqual([r.verdict, r.status, r.evidence.actual.totalDebit6], ["resolved", "settled", "65000"]);
  const done = await x.store.getJournal(x.id);
  assert.deepEqual(done.predecessors, e.predecessors, "predecessor evidence survives later transitions");
  const v = EX.listGasExecutions(await x.store.listJournal(), x.record)[0];
  assert.deepEqual([v.status, v.funded, v.predecessors], ["settled", true, 1]);
  assert.deepEqual([R2.posts, sub.n, x.R.posts], [1, 1, 1]);
});

test("concurrent fresh same-nonce re-admissions: exactly one is admitted, signed and sent", async () => {
  const x = await refusedFirst();
  await expire(x);
  await rec(x);
  const R2 = relayFor(x.W, { mode: "unreachable" });
  const sub = countingSubtle();
  const now = x.W.time;
  const res = await Promise.allSettled([confirmAt(x, reviewAt(x.record, now), R2.relay, sub),
    confirmAt(x, reviewAt(x.record, now, { deadline: now + 301n }), R2.relay, sub)]);
  assert.deepEqual([R2.posts, sub.n], [1, 1]);
  assert.equal(res.filter((r) => r.status === "rejected" && ["execute_exists", "journal_changed", "unreconciled_execute"].includes(r.reason?.code)).length, 1);
  const e = await x.store.getJournal(x.id);
  assert.deepEqual([e.status, e.predecessors.length], ["unknown", 1]);
});

test("the exact old signed digest is never re-admitted (even with a stale local clock)", async () => {
  const x = await refusedFirst();
  await expire(x);
  await rec(x);
  const snap = await x.store.getJournal(x.id);
  const R2 = relayFor(x.W);
  const sub = countingSubtle();
  await assert.rejects(confirmAt(x, x.review, R2.relay, sub, NOW), code("digest_reused"));
  await assert.rejects(confirmAt(x, x.review, R2.relay, sub, x.W.time), code("call_deadline_passed"));
  assert.deepEqual(await x.store.getJournal(x.id), snap);
  assert.deepEqual([R2.posts, sub.n], [0, 0]);
});

test("settled entries are never replaced; refused entries only with a fresh expiry proof", async () => {
  const t = await setup();
  const s = { ...t, X: expiryChain(t.W), R: relayFor(t.W, { mode: "ok" }) };
  const review = reviewFor(t.record);
  s.id = EX.execId(t.record.sid, review.call.execute.nonce);
  await EX.confirmGasFund({ runtime, store: t.store, record: t.record, review, relay: s.R.relay, relayBase: RELAY_BASE, rpc: s.X.rpc, now: NOW });
  t.W.mineEmpty(2);
  t.W.finalized = t.W.head;
  assert.equal((await rec(s)).status, "settled");
  s.X.seq.set(key(s, 1n), 1n);                              // the real vault now shows the nonce consumed
  await expire(s);
  const snap = await t.store.getJournal(s.id);
  await assert.rejects(confirmAt(s, reviewAt(t.record, t.W.time), s.R.relay, countingSubtle()), code("execute_exists"));
  assert.deepEqual(await rec(s), { verdict: "resolved", status: "settled", id: s.id });
  assert.deepEqual(await t.store.getJournal(s.id), snap, "settled record untouched");
  assert.equal(s.R.posts, 1);

  const u = await setup();
  const q = { ...u, X: expiryChain(u.W), R: relayFor(u.W, { mode: "refuse" }) };
  const rv = reviewFor(u.record);
  q.id = EX.execId(u.record.sid, rv.call.execute.nonce);
  await assert.rejects(EX.confirmGasFund({ runtime, store: u.store, record: u.record, review: rv, relay: q.R.relay, relayBase: RELAY_BASE, rpc: q.X.rpc, now: NOW }));
  assert.equal((await u.store.getJournal(q.id)).status, "refused");
  q.R.mode = "unreachable";
  await assert.rejects(confirmAt(q, reviewAt(u.record, NOW, { deadline: NOW + 301n }), q.R.relay, countingSubtle(), NOW), reasonIs("not_past_deadline"));
  assert.equal(q.R.posts, 1, "a refused record is not replaced without the proof");
  await expire(q);
  await assert.rejects(confirmAt(q, reviewAt(u.record, u.W.time), q.R.relay, countingSubtle()), code("relay_unreachable"));
  const e = await u.store.getJournal(q.id);
  assert.deepEqual([e.status, e.predecessors[0].status, e.predecessors[0].outcome.code, e.predecessors[0].release.kind],
    ["unknown", "refused", "quote_moved", "expired_unused"]);
  assert.equal(q.R.posts, 2);
});

test("bounded predecessor history: the next re-admission after MAX_PREDECESSORS is refused", async () => {
  const x = await refusedFirst();
  const R2 = relayFor(x.W, { mode: "unreachable" });
  const sub = countingSubtle();
  for (let k = 1; k <= EX.MAX_PREDECESSORS; k++) {
    await expire(x);
    assert.equal((await rec(x)).status, "expired_unused", `cycle ${k}`);
    await assert.rejects(confirmAt(x, reviewAt(x.record, x.W.time), R2.relay, sub), code("relay_unreachable"));
    assert.equal((await x.store.getJournal(x.id)).predecessors.length, k);
  }
  await expire(x);
  assert.equal((await rec(x)).status, "expired_unused");
  await assert.rejects(confirmAt(x, reviewAt(x.record, x.W.time), R2.relay, sub), code("predecessor_history_full"));
  assert.deepEqual([x.R.posts + R2.posts, x.sub.n + sub.n], [1 + EX.MAX_PREDECESSORS, 1 + EX.MAX_PREDECESSORS]);
  const e = await x.store.getJournal(x.id);
  assert.equal(new Set([e.call.digest, ...e.predecessors.map((p) => p.call.digest)]).size, 1 + EX.MAX_PREDECESSORS, "no digest repeats");
  assert.equal(e.status, "expired_unused", "the exhausted entry itself is left as proven");
});

test("tampered predecessor history is intent_invalid; old-schema entries keep their interpretation", async () => {
  const x = await refusedFirst();
  await expire(x);
  await rec(x);
  await assert.rejects(confirmAt(x, reviewAt(x.record, x.W.time), relayFor(x.W, { mode: "unreachable" }).relay, countingSubtle()), code("relay_unreachable"));
  const good = await x.store.getJournal(x.id);
  const tamper = async (fn) => {
    const s = new MemoryV2Store();
    await s.saveKey(x.record);
    const e = JSON.parse(JSON.stringify(good));
    fn(e);
    await s.putJournal(e);
    return (await EX.reconcileGasExecution({ runtime, store: s, rpc: x.X.rpc, relay: x.R.relay, relayBase: RELAY_BASE, id: x.id })).verdict;
  };
  assert.equal(await tamper((e) => { e.predecessors[0].call.digest = TX("01"); }), "intent_invalid");
  assert.equal(await tamper((e) => { e.predecessorsHash = TX("02"); }), "intent_invalid");
  assert.equal(await tamper((e) => { delete e.predecessors[0].release; e.predecessorsHash = hashOf(e.predecessors); }), "intent_invalid");
  assert.equal(await tamper((e) => { e.predecessors[0].status = "settled"; e.predecessorsHash = hashOf(e.predecessors); }), "intent_invalid");
  assert.equal(await tamper((e) => { e.predecessors = [...e.predecessors, ...Array(EX.MAX_PREDECESSORS).fill(e.predecessors[0])]; e.predecessorsHash = hashOf(e.predecessors); }), "intent_invalid");

  const t = await setup();
  const X = expiryChain(t.W);
  const R = relayFor(t.W);
  const nonce = 1n << 64n;
  const id = EX.execId(t.record.sid, nonce);
  const args = { runtime, store: t.store, record: t.record, review: reviewFor(t.record), relay: R.relay, relayBase: RELAY_BASE, rpc: X.rpc, now: NOW };
  await t.store.putJournal({ id, kind: "gas-execute", sid: t.record.sid, nonce: String(nonce), status: "refused" });
  assert.equal(EX.executionBlockers(await t.store.listJournal(), t.record).length, 1, "r4 'refused' is still not trusted");
  assert.equal((await EX.reconcileGasExecution({ runtime, store: t.store, rpc: X.rpc, relay: R.relay, relayBase: RELAY_BASE, id })).verdict, "legacy_unverifiable");
  await assert.rejects(EX.confirmGasFund(args), code("unreconciled_execute"));
  await t.store.putJournal({ id, kind: "gas-execute", sid: t.record.sid, nonce: String(nonce), status: "settled" });
  await assert.rejects(EX.confirmGasFund(args), code("execute_exists"), "an old-schema entry is never replaced");
  assert.equal(R.posts, 0);
});

test("UI mapping: expired_unused is cleared but never 'funded'; only settled is; the entry re-exports the new names", () => {
  const v = EX.executionStatusView("expired_unused");
  assert.deepEqual([v.cleared, v.funded], [true, false]);
  assert.match(v.text, /never funded/);
  assert.equal(EX.executionStatusView("settled").funded, true);
  for (const s of ["admitted", "dispatching", "unknown", "pending", "observed", "reverted_observed", "superseded_observed"]) {
    const w = EX.executionStatusView(s);
    assert.deepEqual([w.cleared, w.funded, w.text], [false, false, null], s);
  }
  for (const s of ["superseded", "refused", "never_dispatched", "abandoned_before_send"]) assert.equal(EX.executionStatusView(s).funded, false, s);
  assert.ok(EX.CLEARED.includes("expired_unused"));
  for (const s of ["settled", "superseded"]) assert.ok(!EX.RELEASABLE.includes(s), s);
  for (const s of EX.EXPIRABLE) assert.ok(!EX.CLEARED.includes(s), s);
  assert.equal(EX.isBlocking({ kind: "gas-execute", schema: EX.EXEC_SCHEMA, status: "expired_unused" }), false);
  assert.equal(EX.isBlocking({ kind: "gas-execute", status: "expired_unused" }), true, "old-schema rule unchanged: only settled clears");
  for (const n of ["proveExpiredUnused", "executionStatusView", "MAX_PREDECESSORS", "EXPIRABLE", "RELEASABLE", "CLEARED"]) assert.equal(ENTRY[n], EX[n], n);
});
