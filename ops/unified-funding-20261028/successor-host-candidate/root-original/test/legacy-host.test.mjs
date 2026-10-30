// Legacy compatibility of the COMPOSED host (generated/relay/sessions.mjs): host-queue-r1's original /end route tests,
// unchanged in substance, against the copy successor-host-r1 generates. A send without `intent` must run the original
// lines (same answer, same 409 revert, same tx_pending). Scripted RPC only (host-queue-r1/test/fixture-rpc.mjs); funding off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionsService } from "../generated/relay/sessions.mjs";
import { ME, h32, makeCanonical, makePreconfirmed, receipt, header, scripted, memJournal, fakeTime } from "../../host-queue-r1/test/fixture-rpc.mjs";

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
  const svc = createSessionsService({ pc: c.pc, wc: c.wc, account: c.account, chainId: 31337,
    factory: "0x4444444444444444444444444444444444444444", store, journal, log: () => {}, alert: () => {}, now: () => NOW });
  Object.assign(svc.queue, { receiptTimeoutMs: 10, pollMs: 5, maxAttempts: 3, sleep: time.sleep, clock: time.clock });
  return { ...c, svc, store, journal, time };
}

test("legacy /end canonical: the original answer, one send, no intent on the record", async () => {
  const x = mkSvc();
  x.s.afterSend = (h) => makeCanonical(x.s, h);
  assert.deepEqual(await x.svc.route("POST", "/end", { ...END }), { txHash: x.s.sent[0], refund6: 0n });
  assert.equal(x.store.data.revoked[SID], NOW);
  assert.equal(x.s.sends.length, 1);
  assert.equal(x.journal.data.txs.at(-1).status, "mined");
  assert.equal(x.journal.data.txs.at(-1).intent, undefined);
  assert.deepEqual(x.journal.data.intents, {});
  assert.equal(x.svc.queue.nonce, 8);
});

test("legacy /end preconfirmed: 503 tx_pending with the hash (unchanged)", async () => {
  const x = mkSvc();
  x.s.afterSend = (h) => makePreconfirmed(x.s, h);
  const e = await x.svc.route("POST", "/end", { ...END }).then(() => assert.fail("completed"), (err) => err);
  assert.equal(e.status, 503);
  assert.equal(e.code, "tx_pending");
  assert.deepEqual(e.extra.txHashes, x.s.sent);
  assert.equal(x.s.sends.length, 1);
});

test("legacy /end canonical REVERT: the original 409 revert naming the tx (unchanged)", async () => {
  const x = mkSvc();
  x.s.afterSend = (h) => makeCanonical(x.s, h, { status: "reverted" });
  await assert.rejects(x.svc.route("POST", "/end", { ...END }), (e) => e.status === 409 && e.code === "revert" && e.message.includes(x.s.sent[0]));
});

test("legacy /end wrong-hash receipt: never success; replacements identical (unchanged)", async () => {
  const x = mkSvc();
  x.s.afterSend = (h) => { const o = h32(`other:${h}`); x.s.receipts.set(h, receipt(o, { from: ME })); x.s.blocks.set("101", header(101n, { txs: [o] })); };
  await assert.rejects(x.svc.route("POST", "/end", { ...END }), (e) => e.code === "tx_pending");
  assert.equal(x.s.sends.length, 3);
  for (const r of x.s.sends) { assert.equal(r.data, x.s.sends[0].data); assert.equal(r.nonce, 7); }
});

test("funding stays off in the composed host without a manifest/policy", async () => {
  const x = mkSvc();
  await assert.rejects(x.svc.route("GET", "/funding/config", {}), (e) => e.status === 503 && e.code === "funding_disabled");
});
