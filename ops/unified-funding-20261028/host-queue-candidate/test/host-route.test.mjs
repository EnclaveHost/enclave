// The ACTUAL patched host (createSessionsService from patched/relay/sessions.mjs): the ORIGINAL /end route ->
// simulateAndSend -> the new TxQueue, over SCRIPTED RPC answers (no EVM, no signature is verified anywhere here: the
// "simulation" is a scripted success). Only the queue's TIMING is shortened on the live service object; no check is
// replaced. Run `python3 prepare.py` first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionsService } from "../patched/relay/sessions.mjs";
import { ME, h32, makeCanonical, makePreconfirmed, receipt, header, scripted, memJournal, fakeTime } from "./fixture-rpc.mjs";

const VAULT = "0x2222222222222222222222222222222222222222";
const OWNER = "0x3333333333333333333333333333333333333333";
const SID = "0x" + "ab".repeat(32);
const NOW = 1_700_000_000;
const END = { vault: VAULT, sid: SID, deadline: String(NOW + 600), x: "1", y: "2", r: "0x" + "01".repeat(32), s: "0x" + "02".repeat(32) };

function mkSvc() {
  const c = scripted();
  const time = fakeTime();
  const store = { data: { vaults: { [VAULT]: OWNER } }, saveSoon() {}, flush() {} };
  const journal = memJournal();
  const alerts = [];
  const svc = createSessionsService({ pc: c.pc, wc: c.wc, account: c.account, chainId: 31337,
    factory: "0x4444444444444444444444444444444444444444", store, journal, log: () => {}, alert: (k, d) => alerts.push([k, d]),
    now: () => NOW });
  Object.assign(svc.queue, { receiptTimeoutMs: 10, pollMs: 5, maxAttempts: 3, sleep: time.sleep, clock: time.clock });
  return { ...c, svc, store, journal, alerts, time };
}

test("/end on a canonical receipt: the original answer, the revocation, one send", async () => {
  const x = mkSvc();
  x.s.afterSend = (h) => makeCanonical(x.s, h);
  const out = await x.svc.route("POST", "/end", { ...END });
  assert.deepEqual(out, { txHash: x.s.sent[0], refund6: 0n });
  assert.equal(x.store.data.revoked[SID], NOW);
  assert.equal(x.s.sends.length, 1);
  assert.equal(x.s.sends[0].to, VAULT);
  assert.equal(x.journal.data.txs.at(-1).status, "mined");
  assert.equal(x.svc.queue.nonce, 8);
});

test("/end left preconfirmed: 503 tx_pending with the hash, revocation kept, nothing indexed, one send", async () => {
  const x = mkSvc();
  x.s.afterSend = (h) => makePreconfirmed(x.s, h);
  const e = await x.svc.route("POST", "/end", { ...END }).then(() => assert.fail("completed"), (err) => err);
  assert.equal(e.status, 503);
  assert.equal(e.code, "tx_pending");
  assert.deepEqual(e.extra.txHashes, x.s.sent);
  assert.equal(x.store.data.revoked[SID], NOW, "a pending sign-out never weakens the off-chain revocation");
  assert.deepEqual(x.store.data.sessions, {});
  assert.equal(x.s.sends.length, 1);
  assert.equal(x.svc.queue.nonce, 7);
});

test("the HTTP adapter answers a pending send with 503 and the original tx hashes (not a 2xx the SDK would accept)", async () => {
  const x = mkSvc();
  x.s.afterSend = (h) => makePreconfirmed(x.s, h);
  let answered = null;
  const ctx = { json: (_res, code, obj) => { answered = { code, obj }; }, readBody: async () => Buffer.from(JSON.stringify(END)) };
  await x.svc.handle({ method: "POST" }, {}, new URL("http://relay.test/v1/sessions/end"), ctx);
  assert.equal(answered.code, 503);
  assert.equal(answered.obj.code, "tx_pending");
  assert.deepEqual(answered.obj.txHashes, x.s.sent);
});

test("/end on a canonical REVERT: the original 409 revert naming the tx, revocation kept", async () => {
  const x = mkSvc();
  x.s.afterSend = (h) => makeCanonical(x.s, h, { status: "reverted" });
  await assert.rejects(x.svc.route("POST", "/end", { ...END }), (e) => e.status === 409 && e.code === "revert" && e.message.includes(x.s.sent[0]));
  assert.equal(x.store.data.revoked[SID], NOW);
});

test("/end when the node answers with another hash's receipt: never a success; replacements carry identical calldata", async () => {
  const x = mkSvc();
  x.s.afterSend = (h) => { const o = h32(`other:${h}`); x.s.receipts.set(h, receipt(o, { from: ME })); x.s.blocks.set("101", header(101n, { txs: [o] })); };
  await assert.rejects(x.svc.route("POST", "/end", { ...END }), (e) => e.code === "tx_pending");
  assert.equal(x.s.sends.length, 3);
  for (const r of x.s.sends) { assert.equal(r.data, x.s.sends[0].data); assert.equal(r.nonce, 7); assert.equal(r.to, VAULT); }
  assert.equal(x.journal.data.txs.at(-1).hash, undefined);
});
