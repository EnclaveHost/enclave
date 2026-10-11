// Where the box's earnings go (payout.mjs): only to a wallet that the owner confirmed here AND that still declares
// itself on chain, re-read right before paying. Driven with a fake chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Payouts, loadPayoutState, MIN_GAS_WEI } from "./payout.mjs";

const OP = "0x389C3f030a209D04D026228D2D053fEB75DbadcA", MINE = "0x" + "a1".repeat(20), EVIL = "0x" + "e7".repeat(20);
const ID = "0x" + "11".repeat(32);
function fakeChain(o = {}) {
  const c = { declared: MINE, earned: 2_500_000n, gas: MIN_GAS_WEI * 10n, sent: [], reads: 0, fail: null, ...o };
  c.operatorAddress = () => OP;
  c.operatorBalance = async () => c.gas;
  c.readEnclave = async (id) => { c.reads++; if (c.fail) throw new Error(c.fail); assert.equal(id, ID); return { payoutWallet: c.declared ?? "0x0000000000000000000000000000000000000000" }; };
  c.earnedOf = async (a) => { assert.equal(a, OP); return c.earned; };
  c.withdrawEarnings = async (to) => { c.sent.push(to); c.earned = 0n; return "0x" + "77".repeat(32); };
  return c;
}
const mk = (chain, extra = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-payout-")), logs = [];
  return { p: new Payouts({ file: path.join(dir, "payout.json"), enclaveId: ID, chain, log: (m) => logs.push(m), ...extra }), dir, logs };
};

test("nothing confirmed pays nobody, and says whether a wallet has declared itself yet", async () => {
  const chain = fakeChain({ declared: null }); const { p } = mk(chain);
  let s = await p.status();
  assert.equal(s.readable, true); assert.equal(s.payTo, null); assert.equal(s.why, "no payout wallet is set");
  assert.equal(s.earned6, "2500000"); assert.equal(s.paidOut6, "0"); assert.equal(s.enclaveId, ID);
  chain.declared = MINE; p.cache = null;
  s = await p.status();
  assert.match(s.why, /declared on chain for this box but not confirmed here yet/);
  assert.deepEqual(await p.payout({ now: true }), { paid: false, why: s.why }); assert.deepEqual(chain.sent, []);
});

test("the owner can confirm ONLY the wallet the chain names for this box; it survives a restart; null clears", async () => {
  const chain = fakeChain(); const { p, dir } = mk(chain);
  await assert.rejects(p.confirm(EVIL), (e) => e.status === 409 && e.code === "not_declared" && /has not declared itself/.test(e.message));
  await assert.rejects(p.confirm("0x123"), (e) => e.status === 400);
  const s = await p.confirm(MINE.toUpperCase().replace("0X", "0x"));
  assert.equal(s.confirmed, MINE); assert.equal(s.payTo, MINE); assert.equal(s.why, null);
  assert.equal(loadPayoutState(path.join(dir, "payout.json")).confirmed, MINE);
  const again = new Payouts({ file: path.join(dir, "payout.json"), enclaveId: ID, chain });
  assert.equal((await again.status()).payTo, MINE, "a restarted node still pays the confirmed wallet");
  assert.equal((await p.confirm(null)).confirmed, null);
});

test("pays the agreed wallet: at the minimum on its own, any amount on request; recorded and summed", async () => {
  const chain = fakeChain({ earned: 400_000n }); const { p, logs } = mk(chain);
  await p.confirm(MINE);
  const small = await p.payout();
  assert.equal(small.paid, false); assert.match(small.why, /\$0\.40 earned; paid out automatically from \$1\.00/);
  const now = await p.payout({ now: true });
  assert.equal(now.paid, true); assert.equal(now.to, MINE); assert.equal(now.amount6, "400000");
  assert.deepEqual(chain.sent, [MINE]);
  chain.earned = 1_500_000n;
  assert.equal((await p.payout()).paid, true, "from $1 it goes on its own");
  const s = await p.status();
  assert.equal(s.paidOut6, "1900000"); assert.equal(s.history.length, 2); assert.equal(s.history[0].amount6, "1500000", "newest first");
  assert.ok(logs.some((l) => /paid out \$0\.40 of earnings to 0xa1a1/.test(l)));
  assert.equal((await p.payout({ now: true })).paid, false, "nothing left: nothing sent");
  assert.equal(chain.sent.length, 2);
});

test("a stranger overwriting the declaration stops payouts - the declaration is re-read right before paying", async () => {
  const chain = fakeChain(); const { p } = mk(chain);
  await p.confirm(MINE);
  await p.status();                                       // cached with MINE
  chain.declared = EVIL;                                  // anyone may call setPayoutWallet(id)
  const r = await p.payout({ now: true });
  assert.equal(r.paid, false); assert.match(r.why, /the chain now names 0xe7e7.*not the confirmed 0xa1a1.*payouts wait until they agree/);
  assert.deepEqual(chain.sent, [], "nothing went to the stranger, or anywhere");
  chain.declared = null; p.cache = null;
  assert.match((await p.status()).why, /no longer declares itself on chain/);
  chain.declared = MINE;
  assert.equal((await p.payout({ now: true })).paid, true, "the owner's wallet declaring again resumes them");
});

test("pays nobody when the chain cannot be read, the operator is short of gas, or the wallet IS the operator", async () => {
  const chain = fakeChain(); const { p } = mk(chain);
  await p.confirm(MINE);
  chain.fail = "rpc down"; p.cache = null;
  const s = await p.status();
  assert.equal(s.readable, false); assert.match(s.why, /could not be read: rpc down/);
  const r = await p.payout({ now: true });
  assert.equal(r.paid, false); assert.match(r.why, /rpc down/); assert.equal(p.lastError, "rpc down");
  chain.fail = null; chain.gas = MIN_GAS_WEI - 1n;
  assert.match((await p.payout({ now: true })).why, /low on gas/);
  chain.gas = MIN_GAS_WEI; chain.declared = OP; await p.confirm(OP);
  assert.match((await p.payout({ now: true })).why, /operator key, which already holds the earnings/);
  assert.deepEqual(chain.sent, []);
});

test("one payout at a time", async () => {
  const chain = fakeChain(); let release;
  chain.withdrawEarnings = (to) => new Promise((r) => { release = () => r("0x" + "88".repeat(32)); chain.sent.push(to); });
  const { p } = mk(chain);
  await p.confirm(MINE);
  const first = p.payout({ now: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(await p.payout({ now: true }), { paid: false, why: "a payout is already being sent" });
  release(); assert.equal((await first).paid, true); assert.equal(chain.sent.length, 1);
});
