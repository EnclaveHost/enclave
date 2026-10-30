// The ACTUAL patched TxQueue (patched/relay/sessions.mjs, written by prepare.py) driven through SCRIPTED RPC answers
// (test/fixture-rpc.mjs). Offline: no EVM, no signing, no key. These tests show what the queue DOES with each answer
// a node can give; they are not proof that any chain gives those answers. Run `python3 prepare.py` first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TxQueue } from "../generated/relay/sessions.mjs";
import { ZERO32, ME, STRANGER, TO, DATA, h32, txh, receipt, header, makeCanonical, makePreconfirmed, scripted, memJournal, fakeTime }
  from "./fixture-rpc.mjs";

// windows of 10, 20, 30 ms, polled every 5 ms: at most 2 + 4 + 6 = 12 sleeps for a whole send
const MAX_SLEEPS = 12;

function mk(chain = {}, queue = {}) {
  const c = scripted(chain);
  const time = fakeTime();
  const journal = memJournal();
  const alerts = [], logs = [];
  const q = new TxQueue({ pc: c.pc, wc: c.wc, account: c.account, journal, log: (m) => logs.push(m), alert: (k, d) => alerts.push([k, d]),
    receiptTimeoutMs: 10, pollMs: 5, maxAttempts: 3, sleep: time.sleep, clock: time.clock, ...queue });
  return { ...c, q, time, journal, alerts, logs, rec: () => journal.data.txs.at(-1) };
}
const item = { to: TO, data: DATA, label: "t" };

/** every broadcast is the same transaction at the same nonce: only the fees may differ */
function sameTx(sends) {
  for (const r of sends) {
    assert.equal(r.to, TO); assert.equal(r.data, DATA); assert.equal(r.nonce, sends[0].nonce); assert.equal(r.gas, sends[0].gas);
    assert.equal(r.account.address, ME);
  }
}

async function pending(x, p) {
  const e = await p.then(() => assert.fail("completed"), (err) => err);
  assert.equal(e.status, 503);
  assert.equal(e.code, "tx_pending");
  assert.deepEqual(e.extra.txHashes, x.s.sent, "the error names every hash sent, and only those");
  assert.equal(e.extra.nonce, 7);
  for (const h of x.s.sent) assert.ok(e.message.includes(h));
  assert.equal(x.rec().status, "stuck");
  assert.equal(x.rec().hash, undefined, "nothing is recorded as mined");
  assert.equal(x.q.nonce, 7, "the local nonce did not move");
  assert.deepEqual(x.alerts.map(([k, d]) => [k, d.hashes]), [["sessions_stuck_tx", x.s.sent]]);
  assert.ok(x.time.t.sleeps <= MAX_SLEEPS, `bounded (${x.time.t.sleeps} sleeps)`);
  return e;
}

test("canonical success: one send, the node's re-read receipt, nonce + 1, hash journaled before any receipt read", async () => {
  const x = mk();
  let checked = false;
  x.s.onRead = (h) => {
    if (checked) return;
    checked = true;
    assert.deepEqual(x.rec().hashes, [h], "the hash is in the journal before the first receipt read");
    assert.ok(x.journal.flushes >= 1, "and flushed");
  };
  x.s.afterSend = (h) => makeCanonical(x.s, h);
  const rc = await x.q.send(item);
  assert.ok(checked);
  assert.equal(rc.transactionHash, x.s.sent[0]);
  assert.equal(rc.status, "success");
  assert.equal(x.s.sends.length, 1);
  assert.equal(x.s.sends[0].nonce, 7);
  assert.equal(x.q.nonce, 8);
  const r = x.rec();
  assert.equal(r.status, "mined");
  assert.equal(r.hash, x.s.sent[0]);
  assert.equal(r.block, 101);
  assert.equal(r.blockHash, h32("block:101"));
  assert.equal(r.finality, "canonical_at_observation");
  assert.equal(x.time.t.sleeps, 0);
});

test("a canonical REVERTED receipt is returned as reverted (nonce consumed), never as success", async () => {
  const x = mk();
  x.s.afterSend = (h) => makeCanonical(x.s, h, { status: "reverted" });
  const rc = await x.q.send(item);
  assert.equal(rc.status, "reverted");
  assert.equal(x.rec().status, "reverted");
  assert.equal(x.q.nonce, 8);
  assert.equal(x.s.sends.length, 1);
});

test("a preconfirmation that becomes canonical: no completion meanwhile, no replacement, one send", async () => {
  const x = mk();
  x.s.afterSend = (h) => makePreconfirmed(x.s, h);
  const during = [];
  x.time.t.onSleep = (t) => {
    during.push({ nonce: x.q.nonce, status: x.rec().status, reason: x.rec().pendingReason });
    if (t.sleeps === 3) makeCanonical(x.s, x.s.sent[0], { block: 101n });
  };
  const rc = await x.q.send(item);
  assert.equal(x.s.sends.length, 1, "a preconfirmation never triggers a replacement");
  assert.ok(during.length >= 2);
  for (const d of during) assert.deepEqual(d, { nonce: 7, status: "sent", reason: "preconfirmed" });
  assert.notEqual(rc.blockHash, ZERO32);
  assert.equal(x.rec().status, "mined");
  assert.equal(x.q.nonce, 8);
  assert.ok(x.logs.some((m) => /not canonical yet \(preconfirmed\); waiting, not replacing/.test(m)));
  assert.ok(!x.logs.some((m) => /replacing at nonce/.test(m)));
});

test("indefinitely preconfirmed: bounded, 503 tx_pending with the original hash, nonce unchanged, never replaced", async () => {
  const x = mk();
  x.s.afterSend = (h) => makePreconfirmed(x.s, h);
  await pending(x, x.q.send(item));
  assert.equal(x.s.sends.length, 1);
  assert.equal(x.rec().pendingReason, "preconfirmed");
});

test("no receipt at all: the original same-nonce replacement, same calldata/gas/nonce, fees +25% each, then tx_pending", async () => {
  const x = mk();
  await pending(x, x.q.send(item));
  assert.equal(x.s.sends.length, 3);
  sameTx(x.s.sends);
  for (let i = 1; i < 3; i++) {
    const a = x.s.sends[i - 1], b = x.s.sends[i];
    assert.equal(b.maxFeePerGas, a.maxFeePerGas * 125n / 100n + 1n);
    assert.equal(b.maxPriorityFeePerGas, a.maxPriorityFeePerGas * 125n / 100n + 1n);
  }
  assert.equal(x.s.sends[0].maxFeePerGas, 5_000_000n * 2n + 1_000_000n, "the capped first fee is unchanged");
  for (const k of x.s.reads.keys()) assert.ok(x.s.sent.includes(k), "only the record's own hashes are ever looked up");
});

for (const [name, script, reason] of [
  ["unknown status", (s, h) => { makeCanonical(s, h); s.receipts.set(h, receipt(h, { status: "0x2" })); }, "unknown_status"],
  ["zero block number", (s, h) => { s.receipts.set(h, receipt(h, { block: 0n })); s.blocks.set("0", header(0n, { txs: [h] })); }, "no_block_number"],
  ["header at that height has another hash (reorged out)", (s, h) => {
    s.receipts.set(h, receipt(h)); s.blocks.set("101", header(101n, { hash: h32("other:101"), txs: [h] }));
  }, "block_not_canonical"],
  ["re-read disagrees (load-balanced nodes on two forks)", (s, h) => {
    s.receipts.set(h, (i) => receipt(h, { blockHash: h32(i % 2 === 0 ? "fork:a" : "fork:b") }));
    s.blocks.set("101", header(101n, { hash: h32("fork:a"), txs: [h] }));
  }, "receipt_mismatch"],
  ["the header does not list the transaction", (s, h) => { s.receipts.set(h, receipt(h)); s.blocks.set("101", header(101n, { txs: [] })); },
    "not_in_block"],
  ["a log from another block", (s, h) => {
    makeCanonical(s, h); s.receipts.set(h, receipt(h, { logs: [{ blockHash: h32("other"), transactionHash: h, address: TO }] }));
  }, "log_mismatch"],
  ["the header is not served", (s, h) => { s.receipts.set(h, receipt(h)); }, "block_unavailable"],
]) {
  test(`never completes on ${name}: no success, nonce unchanged, one send (${reason})`, async () => {
    const x = mk();
    x.s.afterSend = (h) => script(x.s, h.toLowerCase());
    await pending(x, x.q.send(item));
    assert.equal(x.s.sends.length, 1, "our own receipt was seen: no replacement");
    assert.equal(x.rec().pendingReason, reason);
  });
}

test("a receipt for ANOTHER hash, or from another sender, is never ours: no completion, only our hashes reported", async () => {
  for (const wrong of [
    (s, h) => { const other = h32(`other:${h}`); s.receipts.set(h, receipt(other)); s.blocks.set("101", header(101n, { txs: [other] })); },
    (s, h) => { s.receipts.set(h, receipt(h, { from: STRANGER })); s.blocks.set("101", header(101n, { txs: [h] })); },
  ]) {
    const x = mk();
    x.s.afterSend = (h) => wrong(x.s, h.toLowerCase());
    const e = await pending(x, x.q.send(item));
    assert.equal(x.s.sends.length, 3, "nothing of ours was seen, so the original replacement applies");
    sameTx(x.s.sends);
    assert.ok(!e.extra.txHashes.some((h) => h.startsWith(h32("other").slice(0, 10))));
  }
});

test("a canonical receipt that then reorgs before it reads back: the later canonical block is what completes", async () => {
  const x = mk();
  x.s.afterSend = (h) => { x.s.receipts.set(h.toLowerCase(), receipt(h)); x.s.blocks.set("101", header(101n, { hash: h32("reorg:101"), txs: [] })); };
  x.time.t.onSleep = (t) => { if (t.sleeps === 4) makeCanonical(x.s, x.s.sent[0], { block: 102n, blockHash: h32("new:102") }); };
  const rc = await x.q.send(item);
  assert.equal(rc.blockHash, h32("new:102"));
  assert.equal(x.rec().block, 102);
  assert.equal(x.rec().blockHash, h32("new:102"));
  assert.equal(x.s.sends.length, 1);
});

test("nonce too low after a send: watch our own hash only, never send again, complete when it is canonical", async () => {
  const x = mk({ sendScript: [{}, { error: "nonce too low: next nonce 8, tx nonce 7" }] });
  x.time.t.onSleep = (t) => { if (t.sleeps === 3) makeCanonical(x.s, x.s.sent[0]); };
  const rc = await x.q.send(item);
  assert.equal(rc.transactionHash, x.s.sent[0]);
  assert.equal(x.s.sends.length, 2, "the replacement attempt, then nothing");
  assert.equal(x.s.sent.length, 1);
  assert.equal(x.rec().status, "mined");
  assert.equal(x.q.nonce, 8);
});

test("nonce too low with nothing of ours sent: the original nonce_lost (original error, nonce re-read next time)", async () => {
  const x = mk({ sendScript: [{ error: "nonce too low" }] });
  await assert.rejects(x.q.send(item), /nonce too low/);
  assert.equal(x.rec().status, "nonce_lost");
  assert.equal(x.q.nonce, null);
  assert.equal(x.s.sends.length, 1);
});

test("another transaction holds the nonce (underpriced, nothing of ours sent): 503 nonce_busy, it is never replaced", async () => {
  const x = mk({ sendScript: [{ error: "replacement transaction underpriced" }] });
  const e = await x.q.send(item).then(() => assert.fail("completed"), (err) => err);
  assert.equal(e.status, 503);
  assert.equal(e.code, "nonce_busy");
  assert.equal(x.s.sends.length, 1);
  assert.equal(x.q.nonce, null);
  assert.equal(x.rec().status, "nonce_busy");
});

test("a failed REPLACEMENT keeps watching what was sent: tx_pending with that hash, not send_failed", async () => {
  const x = mk({ sendScript: [{}, { error: "insufficient funds for gas * price + value" }] });
  await pending(x, x.q.send(item));
  assert.equal(x.s.sends.length, 2);
  assert.match(x.rec().error, /insufficient funds/);
});

test("a failed FIRST send is the original send_failed (original error rethrown)", async () => {
  const x = mk({ sendScript: [{ error: "fetch failed" }] });
  await assert.rejects(x.q.send(item), /fetch failed/);
  assert.equal(x.rec().status, "send_failed");
  assert.equal(x.q.nonce, 7);
});

test("one serial lane: the next send starts only after a pending one gives up, at the provider's pending nonce", async () => {
  const x = mk();
  let first = null, aSettled = false, bSentAfterA = null;
  x.s.afterSend = (h, req) => {
    if (!first) { first = h; makePreconfirmed(x.s, h); x.s.pendingNonce = 8; return; }   // the node's pending pool counts it
    bSentAfterA = aSettled;
    makeCanonical(x.s, h, { block: 103n });
  };
  const pA = x.q.send({ ...item, label: "a" });
  pA.catch(() => { aSettled = true; });
  const pB = x.q.send({ ...item, label: "b" });
  await assert.rejects(pA, (e) => e.code === "tx_pending");
  const rcB = await pB;
  assert.equal(bSentAfterA, true);
  assert.deepEqual(x.s.sends.map((r) => r.nonce), [7, 8]);
  assert.equal(rcB.status, "success");
  assert.equal(x.q.nonce, 9);
});

test("reconcile: read-only journal recovery of a pending record, never a send", async () => {
  const x = mk();
  x.s.afterSend = (h) => makePreconfirmed(x.s, h);
  await pending(x, x.q.send(item));
  const h = x.s.sent[0];
  assert.deepEqual(await x.q.reconcile(h), { status: "stuck", pending: "preconfirmed", hashes: [h] });
  assert.equal(x.q.nonce, 7);
  makeCanonical(x.s, h);
  const r = await x.q.reconcile(h.toUpperCase().replace("0X", "0x"));
  assert.equal(r.status, "mined");
  assert.equal(r.hash, h);
  assert.equal(x.q.nonce, 8);
  assert.deepEqual(await x.q.reconcile(h32("never-sent")), { status: "unknown" });
  assert.equal(x.s.sends.length, 1);
});
