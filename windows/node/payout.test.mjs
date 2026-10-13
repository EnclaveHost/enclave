// Where the box's earnings go (payout.mjs): to the payout wallet the owner pasted into the tray on this machine, checked
// for format only - and to nobody when none is set. Driven with a fake chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Payouts, loadPayoutState, isWalletAddress, MIN_GAS_WEI } from "./payout.mjs";

const OP = "0x389C3f030a209D04D026228D2D053fEB75DbadcA", MINE = "0x" + "a1".repeat(20), NEXT = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const ID = "0x" + "11".repeat(32);
function fakeChain(o = {}) {
  const c = { earned: 2_500_000n, gas: MIN_GAS_WEI * 10n, sent: [], fail: null, ...o };
  c.operatorAddress = () => OP;
  c.operatorBalance = async () => { if (c.fail) throw new Error(c.fail); return c.gas; };
  c.earnedOf = async (a) => { assert.equal(a, OP); if (c.fail) throw new Error(c.fail); return c.earned; };
  c.withdrawEarnings = async (to) => { c.sent.push(to); c.earned = 0n; return "0x" + "77".repeat(32); };
  return c;
}
function mk(chain, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-payout-")), logs = [];
  const p = new Payouts({ file: path.join(dir, "payout.json"), enclaveId: ID, chain, log: (m) => logs.push(m), ...extra });
  return { p, dir, logs, file: path.join(dir, "payout.json") };
}

test("format check only: 0x + 40 hex (any case), never the zero address", () => {
  for (const a of [MINE, NEXT, NEXT.toLowerCase(), OP]) assert.equal(isWalletAddress(a), true, a);
  for (const a of ["", "0x", MINE.slice(0, 41), MINE + "0", "0x" + "g1".repeat(20), MINE.slice(2), " " + MINE, "0x" + "0".repeat(40), null, 42])
    assert.equal(isWalletAddress(a), false, String(a));
});

test("no wallet: nobody is paid and the earnings wait in the ledger", async () => {
  const c = fakeChain(), { p } = mk(c);
  const s = await p.status();
  assert.equal(s.readable, true); assert.equal(s.wallet, null); assert.equal(s.payTo, null); assert.match(s.why, /no payout wallet/);
  assert.equal((await p.payout({ now: true })).paid, false); assert.deepEqual(c.sent, []);
});

test("a pasted wallet is saved, survives a restart, and is paid; another replaces it; clearing pays nobody", async () => {
  const c = fakeChain(), { p, file } = mk(c);
  const s = await p.set("  " + MINE + "  ");                       // pasted with spaces
  assert.equal(s.wallet, MINE); assert.equal(s.payTo, MINE);
  assert.equal(loadPayoutState(file).wallet, MINE, "saved");
  const r = await p.payout();
  assert.equal(r.paid, true); assert.deepEqual(c.sent, [MINE]); assert.equal(r.amount6, "2500000");
  const again = new Payouts({ file, enclaveId: ID, chain: c });
  assert.equal((await again.status()).wallet, MINE, "a restart keeps it");
  await p.set(NEXT); c.earned = 5_000_000n;
  assert.equal((await p.payout()).to, NEXT);
  await p.clear(); c.earned = 5_000_000n;
  assert.equal((await p.payout({ now: true })).paid, false); assert.equal(c.sent.length, 2);
  assert.equal((await p.status()).paidOut6, "7500000");
});

test("a malformed address is refused with a 400 and changes nothing", async () => {
  const c = fakeChain(), { p } = mk(c);
  await p.set(MINE);
  for (const bad of ["not a wallet", MINE.slice(0, 30), "0x" + "0".repeat(40), undefined]) {
    await assert.rejects(p.set(bad), (e) => e.status === 400 && e.code === "bad_address");
  }
  assert.equal((await p.status()).wallet, MINE);
});

test("the minimum, gas, the operator itself and an unreadable chain all hold a payout", async () => {
  const c = fakeChain({ earned: 400_000n }), { p } = mk(c);
  await p.set(MINE);
  assert.match((await p.payout()).why, /paid out automatically from \$1\.00/);
  assert.equal((await p.payout({ now: true })).paid, true, "Pay out now pays any amount");
  c.earned = 3_000_000n; c.gas = 1n;
  assert.match((await p.payout()).why, /low on gas/);
  c.gas = MIN_GAS_WEI * 10n;
  await p.set(OP);
  assert.match((await p.payout()).why, /own operator key/);
  await p.set(MINE); c.fail = "RPC down";
  assert.equal((await p.payout()).paid, false);
  p.cache = null; const s = await p.status();   // past the 1-minute cache assert.equal(s.readable, false); assert.match(s.why, /could not be read/);
});

test("a state file from the earlier on-chain scheme keeps its confirmed wallet", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-payout-")), file = path.join(dir, "payout.json");
  fs.writeFileSync(file, JSON.stringify({ confirmed: MINE, confirmedAt: "2026-10-11T00:00:00Z", pending: null, history: [] }));
  assert.equal(loadPayoutState(file).wallet, MINE);
});
