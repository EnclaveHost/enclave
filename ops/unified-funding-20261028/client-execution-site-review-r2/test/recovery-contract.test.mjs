// UNREVIEWED, NOT RUN. The data contract the recovery page section relies on, exercised with the root-reviewed successor
// lib and its fixtures (client-execution-recovery-r1, imported read-only): real WebCrypto P-256 and the unchanged proof
// code over a SCRIPTED chain and relay. This is NOT page testing (no DOM, no IndexedDB); it pins what the page reads:
// listGasExecutions rows (status, blocking, maximum, evidence), the quote gate, record scoping, the confirm result shape.
import test from "node:test";
import assert from "node:assert/strict";
import * as EX from "../../client-execution-recovery-r1/lib/gas-execution.mjs";
import { MemoryV2Store } from "../../client-repair-r4/lib/v2-store.mjs";
import { NOW, RELAY_BASE, countingSubtle, relayFor, reviewFor, runtime, setup } from "../../client-execution-recovery-r1/test/exec-fixtures.mjs";

async function fundWith(mode) {
  const t = await setup();
  const R = relayFor(t.W, { mode });
  const sub = countingSubtle();
  const review = reviewFor(t.record);
  let out = null, err = null;
  try { out = await EX.confirmGasFund({ runtime, store: t.store, record: t.record, review, relay: R.relay, relayBase: RELAY_BASE, rpc: t.W.rpc, now: NOW, subtle: sub }); }
  catch (e) { err = e; }
  return { ...t, R, sub, out, err, id: EX.execId(t.record.sid, review.call.execute.nonce) };
}
const rows = async (x, rec = x.record) => EX.listGasExecutions(await x.store.listJournal(), rec);
const reconcile = (x, store = x.store) => EX.reconcileGasExecution({ runtime, store, rpc: x.W.rpc, relay: x.R.relay, relayBase: RELAY_BASE, id: x.id });
const finalize = (x) => { x.W.mineEmpty(2); x.W.finalized = x.W.head; };

test("lost reply: one blocking 'unknown' row with its maximum survives a JSON reload; observed stays blocking; final clears it", async () => {
  const x = await fundWith("body");
  assert.ok(x.err);
  let r = await rows(x);
  assert.deepEqual(r.map((y) => [y.id, y.status, y.blocking, y.schema]), [[x.id, "unknown", true, EX.EXEC_SCHEMA]]);
  assert.ok(BigInt(r[0].maximum.totalMaximum6) > 0n && r[0].evidence === null);
  const store2 = new MemoryV2Store();                                  // "reload": a fresh store from the persisted JSON
  await store2.saveKey(x.record);
  for (const e of await x.store.listJournal()) await store2.putJournal(JSON.parse(JSON.stringify(e)));
  assert.deepEqual((EX.listGasExecutions(await store2.listJournal(), x.record)).map((y) => y.status), ["unknown"]);
  await assert.rejects(EX.quoteGasFund({ runtime, record: x.record, relay: x.R.relay, scope: { deployments: new Map() }, deployment: x.record.grant.apps[0],
    ethOut: 1n, feeTier: 500, now: NOW, journalEntries: await store2.listJournal() }), (e) => e?.code === "unreconciled_execute");
  const o = await reconcile(x, store2);
  assert.equal(o.status, "observed");
  r = EX.listGasExecutions(await store2.listJournal(), x.record);
  assert.deepEqual([r[0].status, r[0].blocking, !!r[0].evidence?.txHash], ["observed", true, true], "on chain, not final: still a row the page shows");
  finalize(x);
  assert.equal((await reconcile(x, store2)).status, "settled");
  r = EX.listGasExecutions(await store2.listJournal(), x.record);
  assert.deepEqual([r[0].status, r[0].blocking], ["settled", false], "final: the page no longer lists it");
  assert.deepEqual([x.R.posts, x.sub.n], [1, 1], "recovery sent nothing and signed nothing");
});

test("normal success returns the shape the page message uses: canonical but NOT final until a check proves it", async () => {
  const x = await fundWith("ok");
  assert.equal(x.err, null);
  assert.equal(x.out.pending, false);
  assert.equal(x.out.status, "observed", "the page must say 'NOT final yet', not 'final'");
  assert.equal(typeof x.out.settlement.actual.totalDebit6, "bigint");
  assert.equal((await rows(x))[0].blocking, true);
});

test("rows are scoped to the exact record: another record (same owner) sees none", async () => {
  const x = await fundWith("gw502");
  assert.equal((await rows(x)).length, 1);
  assert.deepEqual(await rows(x, { ...x.record, id: "gas-0000", sid: `0x${"74".repeat(32)}` }), []);
  assert.deepEqual(await rows(x, { ...x.record, id: "gas-0000" }), [], "same sid but another record id: none");
});

test("unreachable relay: the row stays 'unknown' and blocking after a read-only check that finds nothing", async () => {
  const x = await fundWith("unreachable");
  const o = await reconcile(x);
  assert.deepEqual([o.verdict, o.status], ["unresolved", "unknown"]);
  assert.equal((await rows(x))[0].blocking, true, "no assertion that it was rejected; it stays reserved");
});
