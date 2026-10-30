// UNREVIEWED, NOT RUN. Offline tests of lib/gas-execution.mjs (client-execution-recovery-r1): real WebCrypto P-256 keys
// and signatures, the reviewed codec, the unchanged r4 canonicalReceipt / receiptFinality / verifySettlement, r4
// MemoryV2Store and relayClient; SCRIPTED chain and relay (test/exec-fixtures.mjs). No network, wallet, funds or IndexedDB.
import test from "node:test";
import assert from "node:assert/strict";
import * as EX from "../lib/gas-execution.mjs";
import * as ENTRY from "../lib/browser-entry.mjs";
import * as R4FC from "../../client-repair-r4/lib/funding-client.mjs";
import * as R4MIG from "../../client-repair-r4/lib/migration.mjs";
import { RelayError } from "../../client-repair-r4/lib/funding-client.mjs";
import { MemoryV2Store } from "../../client-repair-r4/lib/v2-store.mjs";
import { hashOf, lower } from "../../client-repair-r4/lib/util.mjs";
import { DEP, NOW, RELAY_BASE, TX, cfg, code, countingSubtle, executeInput, relayFor, reviewFor, runtime, settlementLogs, setup } from "./exec-fixtures.mjs";

async function run(mode, opts = {}) {
  const t = await setup();
  const R = relayFor(t.W, { mode, ...(opts.relay ?? {}) });
  const sub = opts.subtle ?? countingSubtle();
  const review = opts.review ?? reviewFor(t.record, opts.reviewOpts);
  let err = null, out = null;
  try {
    out = await EX.confirmGasFund({ runtime, store: t.store, record: t.record, review, relay: R.relay, relayBase: RELAY_BASE, rpc: t.W.rpc, now: NOW, subtle: sub });
  } catch (e) { err = e; }
  const id = EX.execId(t.record.sid, review.call.execute.nonce);
  return { ...t, R, sub, review, err, out, id, entry: await t.store.getJournal(id) };
}
const reconcile = (x, over = {}) => EX.reconcileGasExecution({ runtime, store: x.store, rpc: x.W.rpc, relay: x.R.relay, relayBase: RELAY_BASE, id: x.id, ...over });
const finalize = (x) => { x.W.mineEmpty(2); x.W.finalized = x.W.head; };
const blockers = async (x) => EX.executionBlockers(await x.store.listJournal(), x.record);
const leaves = (v, out = []) => { if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, out)); else out.push(typeof v); return out; };
const quote = (x) => EX.quoteGasFund({ runtime, record: x.record, relay: x.R.relay, scope: { deployments: new Map([[DEP, { holder: cfg.legacyVault, env: 2, appId: DEP }]]) },
  deployment: DEP, ethOut: 20_000_000_000_000n, feeTier: 500, now: NOW, journalEntries: undefined });

test("body lost after HTTP 200 headers: UNKNOWN, exact public call journaled, then proven read-only from the chain", async () => {
  const x = await run("body");
  assert.ok(x.err, "the caller sees the failure");
  assert.equal(x.entry.status, "unknown");
  assert.equal(x.entry.call.args, lower(x.review.call.args));
  assert.equal(x.entry.call.digest, lower(x.review.call.digest));
  assert.equal(x.entry.outcome.phase, "body_or_transport");
  for (const k of ["privateKey", "\"r\"", "\"s\"", "\"sig\"", "signature"]) assert.equal(JSON.stringify(x.entry).includes(k), false, `journal holds ${k}`);
  assert.deepEqual([x.R.posts, x.sub.n], [1, 1]);
  const r1 = await reconcile(x);
  assert.equal(r1.status, "observed", "canonical, not final");
  assert.equal(r1.evidence.txHash, x.R.last);
  finalize(x);
  const r2 = await reconcile(x);
  assert.deepEqual([r2.verdict, r2.status], ["resolved", "settled"]);
  assert.equal(r2.evidence.actual.totalDebit6, String(40_000n + 25_000n));
  assert.deepEqual([x.R.posts, x.sub.n], [1, 1], "reconcile sent nothing and signed nothing");
  assert.deepEqual(await blockers(x), []);
});

test("gateway 502 after dispatch: UNKNOWN (never refused), recovered from the chain", async () => {
  const x = await run("gw502");
  assert.equal(x.entry.status, "unknown");
  assert.equal(x.entry.outcome.status, 502);
  finalize(x);
  assert.equal((await reconcile(x)).status, "settled");
  assert.equal(x.R.posts, 1);
});

test("connection lost / unreachable: UNKNOWN; nothing on chain stays UNRESOLVED and keeps the reservation forever", async () => {
  const x = await run("unreachable");
  assert.equal(x.entry.status, "unknown");
  x.W.mineEmpty(700);
  x.W.time += 10_000n;                                  // chain time far past the deadline: still never cleared
  const r = await reconcile(x);
  assert.equal(r.verdict, "unresolved");
  assert.equal(r.status, "unknown");
  for (const [from, to] of x.W.logRanges) assert.ok(to - from <= EX.MAX_DISCOVERY_BLOCKS, "log discovery is bounded from the anchor");
  assert.equal(x.W.logRanges[0][0], BigInt(x.entry.anchor.number), "discovery starts at the persisted anchor");
  await assert.rejects(EX.quoteGasFund({ runtime, record: x.record, relay: x.R.relay, scope: { deployments: new Map() }, deployment: DEP,
    ethOut: 1n, feeTier: 500, now: NOW, journalEntries: await x.store.listJournal() }), code("unreconciled_execute"));
  const next = reviewFor(x.record, { seq: 1n });
  await assert.rejects(EX.confirmGasFund({ runtime, store: x.store, record: x.record, review: next, relay: x.R.relay, relayBase: RELAY_BASE,
    rpc: x.W.rpc, now: NOW, subtle: x.sub }), code("unreconciled_execute"));
  assert.deepEqual([x.R.posts, x.sub.n], [1, 1], "no second send or signature");
});

test("malformed or hashless success bodies are UNKNOWN and never unlock a fresh spend", async () => {
  for (const mode of ["malformed", "nohash"]) {
    const x = await run(mode);
    assert.equal(x.err?.code, "relay_malformed_success", mode);
    assert.equal(x.entry.status, "unknown", mode);
    assert.equal((await blockers(x)).length, 1, mode);
  }
});

test("only explicit, well-formed pre-admission refusals are 'refused'; look-alikes stay unknown", async () => {
  const x = await run("refuse");
  assert.equal(x.entry.status, "refused");
  assert.deepEqual(await blockers(x), [], "a definitive refusal clears");
  assert.equal((await run("revert409")).entry.status, "unknown", "host 409 revert is also used after an on-chain revert");
  const C = (status, code, detail) => EX.classifyExecuteFailure(new RelayError(code, "x", status, detail)).kind;
  assert.equal(C(409, "quote_moved", { code: "quote_moved", error: "re-quote" }), "refused");
  assert.equal(C(409, "quote_moved", {}), "unknown", "body not the relay's JSON");
  assert.equal(C(409, "reverted", { code: "reverted", error: "on chain", txHash: TX("12") }), "unknown");
  assert.equal(C(409, "quote_moved", { code: "quote_moved", error: "x", txHash: TX("12") }), "unknown", "a refusal naming a tx is not a refusal");
  assert.equal(C(503, "funding_disabled", { code: "funding_disabled", error: "off" }), "unknown", "every 5xx is unknown");
  assert.equal(C(502, "settlement_args", { code: "settlement_args", error: "x" }), "unknown", "the relay's own 502s come after a send");
  assert.equal(C(400, "relay", {}), "unknown", "an HTML 400 from a proxy proves nothing");
  assert.deepEqual(EX.classifyExecuteFailure(new RelayError("reverted", "x", 409, { code: "reverted", error: "x", txHash: TX("12") })).hints, [TX("12")]);
});

test("202 with a known hash is PENDING; later canonical -> observed -> final -> settled; nothing resent", async () => {
  const x = await run("pending");
  assert.equal(x.out.pending, true);
  assert.equal(x.entry.status, "pending");
  assert.deepEqual(x.entry.hints.txHashes, [x.R.last]);
  assert.equal((await reconcile(x)).status, "pending", "not canonical yet: unchanged");
  x.W.hidden.delete(x.R.last);
  assert.equal((await reconcile(x)).status, "observed");
  finalize(x);
  assert.equal((await reconcile(x)).status, "settled");
  assert.equal(x.R.posts, 1);
});

test("normal success: canonical but NOT final blocks the next quote until a reconcile proves finality", async () => {
  const x = await run("ok");
  assert.equal(x.out.pending, false);
  assert.equal(x.out.status, "observed");
  assert.equal(x.out.settlement.actual.totalDebit6, 65_000n);
  assert.equal((await blockers(x)).length, 1);
  finalize(x);
  assert.equal((await reconcile(x)).status, "settled");
  assert.deepEqual(await blockers(x), []);
});

test("durable serialization: the journal is plain JSON; a fresh store + fresh clients after 'reload' recover it", async () => {
  const x = await run("body");
  assert.ok(leaves(x.entry).every((t) => ["string", "number", "boolean", "object"].includes(t)), "no bigint / function leaves");
  const reloaded = JSON.parse(JSON.stringify(x.entry));
  assert.deepEqual(reloaded, x.entry);
  const store2 = new MemoryV2Store();
  await store2.saveKey(x.record);
  await store2.putJournal(reloaded);
  const R2 = relayFor(x.W, { mode: "ok" });
  finalize(x);
  const r = await EX.reconcileGasExecution({ runtime, store: store2, rpc: x.W.rpc, relay: R2.relay, relayBase: RELAY_BASE, id: x.id });
  assert.equal(r.status, "settled");
  assert.equal(R2.posts, 0);
});

test("concurrent confirmations: the same review sends once; two nonces of one session never both send", async () => {
  const t = await setup();
  const R = relayFor(t.W, { mode: "body" });
  const review = reviewFor(t.record);
  const args = { runtime, store: t.store, record: t.record, review, relay: R.relay, relayBase: RELAY_BASE, rpc: t.W.rpc, now: NOW };
  const res = await Promise.allSettled([EX.confirmGasFund(args), EX.confirmGasFund(args)]);
  assert.equal(R.posts, 1);
  assert.ok(res.some((r) => r.status === "rejected" && ["execute_exists", "unreconciled_execute"].includes(r.reason?.code)));
  const u = await setup();
  const R2 = relayFor(u.W, { mode: "body" });
  const a = { runtime, store: u.store, record: u.record, relay: R2.relay, relayBase: RELAY_BASE, rpc: u.W.rpc, now: NOW };
  await Promise.allSettled([EX.confirmGasFund({ ...a, review: reviewFor(u.record, { seq: 0n }) }), EX.confirmGasFund({ ...a, review: reviewFor(u.record, { seq: 1n }) })]);
  assert.ok(R2.posts <= 1, `at most one send, saw ${R2.posts}`);
});

test("tampered stored call / runtime / record are refused before any hint is trusted; entry unchanged", async () => {
  const x = await run("body");
  const tamper = async (fn) => {
    const s = new MemoryV2Store();
    await s.saveKey(x.record);
    const e = JSON.parse(JSON.stringify(x.entry));
    fn(e);
    await s.putJournal(e);
    return EX.reconcileGasExecution({ runtime, store: s, rpc: x.W.rpc, relay: x.R.relay, relayBase: RELAY_BASE, id: x.id });
  };
  assert.equal((await tamper((e) => { e.call.args = e.call.args.replace(/.$/, "f"); })).verdict, "intent_invalid");
  const refeed = (e) => { e.call.fee = "1"; const { runtime: rt, relayer, record, relay, sid, nonce, deployment, holder, call, maximum, anchor } = e;
    e.intentHash = hashOf({ runtime: rt, relayer, record, relay, sid, nonce, deployment, holder, call, maximum, anchor }); };
  assert.equal((await tamper(refeed)).verdict, "intent_invalid", "a recomputed intentHash does not help: the call no longer re-derives");
  const other = { ...runtime, cfg: { ...runtime.cfg, vault: `0x${"99".repeat(20)}` } };
  assert.equal((await reconcile(x, { runtime: other })).verdict, "intent_invalid");
  assert.equal((await reconcile(x, { relayBase: "https://other.invalid" })).verdict, "intent_invalid");
  assert.equal((await x.store.getJournal(x.id)).status, "unknown");
});

test("foreign hash hint, reorg, moved header, wrong log metadata, removed log, unbound transaction", async () => {
  // foreign hint: a canonical tx of ANOTHER operation of this session (different nonce) is not ours
  const f = await run("unreachable");
  const other = reviewFor(f.record, { seq: 7n });
  const oh = f.W.mineTx({ to: cfg.vault, input: executeInput({ sid: f.record.sid, nonce: other.call.execute.nonce, args: other.call.args, fee: 25_000n,
    deadline: other.call.execute.deadline, x: f.record.x, y: f.record.y }), logs: settlementLogs({ sid: f.record.sid, nonce: other.call.execute.nonce,
    args: other.call.args, fee: 25_000n, deployment: DEP, holder: cfg.legacyVault, ethOut: 20_000_000_000_000n, maxUsdcIn6: 50_000n, used: 40_000n }) });
  f.R.sessionOps.push({ nonce: f.entry.nonce, tx: oh });                 // the relay index lies about our nonce
  assert.equal((await reconcile(f)).verdict, "unresolved");
  // reorg after a non-final observation: evidence kept in history, the execution is unknown again
  const x = await run("ok");
  x.W.reorg(BigInt(x.entry.evidence?.block ?? (await x.store.getJournal(x.id)).evidence.block));
  const r = await reconcile(x);
  assert.equal(r.status, "unknown");
  const e = await x.store.getJournal(x.id);
  assert.ok(e.history.some((h) => h.evidence?.txHash === x.R.last), "the earlier evidence is retained");
  // wrong log metadata / removed log / preconfirmation on an unknown execution
  for (const [name, bend] of [["log blockHash", (rc) => { rc.logs[0].blockHash = TX("ee"); }], ["removed", (rc) => { rc.logs[0].removed = true; }],
    ["preconfirmation", (rc) => { rc.blockHash = `0x${"0".repeat(64)}`; }]]) {
    const y = await run("body");
    bend(y.W.receipts.get(y.R.last));
    const out = await reconcile(y);
    assert.equal(out.verdict, "unresolved", name);
    assert.equal(out.status, "unknown", name);
  }
  // our exact op inside a transaction that is not a direct call of our signed execute: never settled, kept for review
  const z = await run("body");
  const tx = z.W.txs.get(z.R.last);
  z.W.extraTx.set(z.R.last, { ...tx, to: `0x${"42".repeat(20)}` });
  assert.equal((await reconcile(z)).verdict, "contradiction");
  assert.equal((await z.store.getJournal(z.id)).status, "unknown");
});

test("nonce consumed by ANOTHER canonical operation: superseded only when proven and final", async () => {
  const x = await run("unreachable");
  const rival = reviewFor(x.record, { maxUsdcIn6: 60_000n });       // same nonce, different signed args
  x.W.mineTx({ to: cfg.vault, input: executeInput({ sid: x.record.sid, nonce: rival.call.execute.nonce, args: rival.call.args, fee: 25_000n,
    deadline: rival.call.execute.deadline, x: x.record.x, y: x.record.y }), logs: settlementLogs({ sid: x.record.sid, nonce: rival.call.execute.nonce,
    args: rival.call.args, fee: 25_000n, deployment: DEP, holder: cfg.legacyVault, ethOut: 20_000_000_000_000n, maxUsdcIn6: 60_000n, used: 40_000n }) });
  const r1 = await reconcile(x);
  assert.equal(r1.status, "superseded_observed");
  assert.equal((await blockers(x)).length, 1, "not final: still reserved");
  finalize(x);
  assert.equal((await reconcile(x)).status, "superseded");
  assert.deepEqual(await blockers(x), []);
});

test("an exact call reverted on chain stays reserved (the signature may still be usable)", async () => {
  const x = await run("unreachable");
  const b = { sid: x.record.sid, nonce: x.review.call.execute.nonce, args: x.review.call.args, fee: x.review.call.execute.fee,
    deadline: x.review.call.execute.deadline, x: x.record.x, y: x.record.y };
  const h = x.W.mineTx({ to: cfg.vault, input: executeInput(b), logs: [], status: "0x0" });
  x.R.sessionOps.push({ nonce: x.entry.nonce, tx: h });
  const r = await reconcile(x);
  assert.deepEqual([r.verdict, r.status, r.why], ["unresolved", "reverted_observed", "reverted_signature_may_still_be_usable"]);
  assert.equal((await blockers(x)).length, 1);
});

test("binding before signing: a tampered review, another relay or another owner sends and signs nothing", async () => {
  const t = await setup();
  const R = relayFor(t.W, { mode: "ok" });
  const sub = countingSubtle();
  const good = reviewFor(t.record);
  const base = { runtime, store: t.store, record: t.record, relay: R.relay, relayBase: RELAY_BASE, rpc: t.W.rpc, now: NOW, subtle: sub };
  const bent = { ...good, call: { ...good.call, digest: TX("01") } };
  await assert.rejects(EX.confirmGasFund({ ...base, review: bent }), code("review_not_bound"));
  await assert.rejects(EX.confirmGasFund({ ...base, review: { ...good, totals: { ...good.totals, totalMaximum6: 1n } } }), code("review_not_bound"));
  await assert.rejects(EX.confirmGasFund({ ...base, review: good, relayBase: "https://other.invalid" }), code("record_relay_mismatch"));
  await assert.rejects(EX.confirmGasFund({ ...base, review: good, record: { ...t.record, owner: `0x${"98".repeat(20)}` } }), code("record_runtime_mismatch"));
  assert.deepEqual([R.posts, sub.n, (await t.store.listJournal()).length], [0, 0, 0]);
});

test("a crash before the dispatching marker is provably unsent: reconcile marks it never_dispatched", async () => {
  const crash = { sign: async () => { throw new Error("tab closed while signing"); } };
  const x = await run("ok", { subtle: crash });
  assert.ok(x.err);
  assert.equal(x.entry.status, "admitted");
  assert.equal(x.R.posts, 0);
  assert.deepEqual([(await reconcile(x)).status, (await blockers(x)).length], ["never_dispatched", 0]);
});

test("the successor entry overrides only the execution names; migration and every other r4 export are the same objects", () => {
  for (const n of ["confirmGasFund", "quoteGasFund"]) assert.equal(ENTRY[n], EX[n], n);
  for (const n of ["reconcileGasExecution", "listGasExecutions", "executionBlockers"]) assert.equal(typeof ENTRY[n], "function", n);
  for (const n of ["relayClient", "verifyRuntime", "selectGasRecord", "ownerControl", "endGasSession", "verifySettlement", "canonicalReceipt"]) assert.equal(ENTRY[n], R4FC[n], n);
  for (const n of ["buildMigrationPlan", "signSteps", "runMigration", "reconcileMigration", "rearmStep", "loadLegacyEvidence"]) assert.equal(ENTRY[n], R4MIG[n], n);
  assert.notEqual(ENTRY.confirmGasFund, R4FC.confirmGasFund);
});
