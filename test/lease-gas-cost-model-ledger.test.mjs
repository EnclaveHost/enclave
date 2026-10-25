// The owner cost model's renewal count against the DEPLOYED ledger itself (rev 16d source, built and run on a local anvil:
// test/helpers/lease-gas-world.mjs), not a transcription of it: a rate-0 (self-hosted) lease and a paid lease are claimed
// and renewed a fixed lead before leaseUntil until they cover the same period, and the count each needed is what
// renewalsFor says. The reserve's own renew gate (statusOf) fixes the conservative lead (the renew window) and refuses an
// extension below the owner's minimum, as renewalCadence says. Local chain only: no RPC, no relay, nothing on Base.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startWorld, haveAnvil, ZERO32 } from "./helpers/lease-gas-world.mjs";
import { KIND, STATUS } from "../client/lease-executor-client.mjs";
import { renewalCadence, renewalsFor, OwnerRefusal } from "../network/lease-gas-owner.mjs";

const T = { skip: !haveAnvil && "needs anvil and forge", timeout: 240_000 };
let W, o, selfOp, paidOp;
before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  o = await W.owner();
  selfOp = await W.operator("self.example:443"); paidOp = await W.operator("paid.example:443");
  // the owner names itself the payout wallet of its own box: the ledger's rate for o's deployments there is 0 (rev 12)
  await W.write(o.key, W.addr.registry, W.A.registry.abi, "setPayoutWallet", [selfOp.enclaveId]);
  // local test chain only: the operators send their own ledger calls here (the reserve path is checked by statusOf below)
  await W.fund(selfOp.address); await W.fund(paidOp.address);
});
after(() => W?.stop());

const leaseSec = async () => Number(await W.pc.readContract({ address: W.addr.ledger, abi: W.A.ledger.abi, functionName: "leaseSec" }));
const blockTime = async (rc) => Number((await W.pc.getBlock({ blockNumber: rc.blockNumber })).timestamp);
const claim = async (op, id) => blockTime(await W.write(op.key, W.addr.ledger, W.A.ledger.abi, "claim", [id, op.enclaveId]));
async function renewAt(op, id, ts) {
  await W.rpc("evm_setNextBlockTimestamp", [ts]);
  return blockTime(await W.write(op.key, W.addr.ledger, W.A.ledger.abi, "renew", [id]));
}
/** Claim, then renew `lead` s before every leaseUntil until the lease covers `seconds` from the claim; the ledger's own
 *  leaseUntil after every step. */
async function keepUp(op, id, seconds, lead) {
  const t0 = await claim(op, id);
  const steps = [];
  let until = Number((await W.row(id)).leaseUntil);
  while (until - t0 < seconds) {
    const landed = await renewAt(op, id, until - lead);
    const next = Number((await W.row(id)).leaseUntil);
    steps.push({ landed, before: until, after: next });
    until = next;
  }
  return { t0, steps, rate6: (await W.row(id)).rate };
}
// at "latest", which anvil runs at the latest mined block's own timestamp; an explicit blockNumber there answers as of one
// second earlier (measured: at 300 s remaining "latest" says Ready, the same block by number NotInRenewWindow)
const statusOf = async (id, op) => {
  const [st] = await W.pc.readContract({ address: W.addr.reserve, abi: W.A.reserve.abi, functionName: "statusOf", args: [id, KIND.renew, ZERO32, op.address], blockTag: "latest" });
  return STATUS[Number(st)];
};
/** the reserve's renew status exactly `remaining` s before leaseUntil (a block mined at that time) */
async function statusAtRemaining(id, op, remaining) {
  await W.warpTo(Number((await W.row(id)).leaseUntil) - remaining);
  return statusOf(id, op);
}

test("a rate-0 renew restarts the lease from its own block; a paid renew extends from leaseUntil; renewalsFor counts each", T, async () => {
  const L = await leaseSec();
  assert.equal(L, 1800, "the rev-16d ledger's lease quantum");
  const period = 3 * 3600, lead = 260;   // ~ the measured landing lead on Base (2026-10-21: 222..280 s at renewWindow 300)
  const free = await keepUp(selfOp, await W.create(o, { fund6: 0n }), period, lead);
  assert.equal(free.rate6, 0n, "self-hosted: rate 0");
  for (const s of free.steps) {
    assert.equal(s.before - s.landed, lead);
    assert.equal(s.after, s.landed + L, "rate 0: leaseUntil = the renew's block + leaseSec (the lead is given up)");
  }
  const paid = await keepUp(paidOp, await W.create(o, { fund6: 100_000_000n }), period, lead);
  assert.ok(paid.rate6 > 0n, "a box the owner does not name: a paid rate");
  for (const s of paid.steps) assert.equal(s.after, s.before + L, "paid: leaseUntil = the previous leaseUntil + leaseSec, wherever the renew lands");
  // the counts the ledger needed are the model's; the free lease needed more for the same period
  assert.equal(BigInt(free.steps.length), renewalsFor(period, { leaseSec: L, rate6: free.rate6, renewLeadSec: lead, renewWindow: 300 }));
  assert.equal(BigInt(paid.steps.length), renewalsFor(period, { leaseSec: L, rate6: paid.rate6, renewWindow: 300 }));
  assert.equal(free.steps.length, 6); assert.equal(paid.steps.length, 5);
  // an unknown rate is counted as the more frequent of the two
  assert.equal(renewalsFor(period, { leaseSec: L, renewLeadSec: lead, renewWindow: 300 }), BigInt(free.steps.length));
  // and the cycle the ledger produced is the model's cycleSec
  for (let i = 1; i < free.steps.length; i++) assert.equal(free.steps[i].landed - free.steps[i - 1].landed, renewalCadence({ leaseSec: L, rate6: 0n, renewLeadSec: lead }).cycleSec);
  for (let i = 1; i < paid.steps.length; i++) assert.equal(paid.steps[i].landed - paid.steps[i - 1].landed, renewalCadence({ leaseSec: L, rate6: paid.rate6 }).cycleSec);
});

test("the reserve's renew window is the earliest a sponsored renew may land: the conservative rate-0 lead", T, async () => {
  const id = await W.create(o, { fund6: 0n });
  await W.enable(o, id, { p: { renewWindow: 300 } });
  await claim(selfOp, id);
  assert.equal(await statusAtRemaining(id, selfOp, 301), "NotInRenewWindow");
  assert.equal(await statusAtRemaining(id, selfOp, 300), "Ready");
  // the model takes the window as the lead when none is measured, and refuses a lead the reserve would not sponsor
  const c = renewalCadence({ leaseSec: 1800, rate6: 0n, renewWindow: 300 });
  assert.equal(c.renewLeadSec, 300); assert.equal(c.cycleSec, 1500);
  assert.throws(() => renewalCadence({ leaseSec: 1800, rate6: 0n, renewWindow: 300, renewLeadSec: 301 }), /cannot land 301 s before leaseUntil/);
});

test("minimum extension: a paid lease's last short extension and a rate-0 policy above leaseSec are refused as the model says", T, async () => {
  // a paid lease whose balance buys leaseSec at the claim and then 599 s / 600 s more
  const probe = await keepUp(paidOp, await W.create(o, { fund6: 100_000_000n }), 1, 0);   // claim only: read the rate this box charges
  const rate = probe.rate6;
  for (const [extra, want] of [[599n, "ExtensionTooShort"], [600n, "Ready"]]) {
    const id = await W.create(o, { fund6: rate * (1800n + extra) });
    await W.enable(o, id, { p: { renewWindow: 300, minExtension: 600 } });
    await claim(paidOp, id);
    assert.equal((await W.row(id)).balance6, rate * extra, "the claim burned one full quantum");
    assert.equal(await statusAtRemaining(id, paidOp, 200), want, `${extra} s left`);
    if (want === "Ready") assert.equal(renewalCadence({ leaseSec: 1800, rate6: rate, extensionSec: Number(extra), minExtension: 600 }).cycleSec, 600);
    else assert.throws(() => renewalCadence({ leaseSec: 1800, rate6: rate, extensionSec: Number(extra), minExtension: 600 }), OwnerRefusal);
  }
  // rate 0 buys exactly leaseSec: a minimum extension above it refuses every sponsored renew
  const id = await W.create(o, { fund6: 0n });
  await W.enable(o, id, { p: { renewWindow: 300, minExtension: 1801 } });
  await claim(selfOp, id);
  assert.equal(await statusAtRemaining(id, selfOp, 200), "ExtensionTooShort");
  assert.match(renewalCadence({ leaseSec: 1800, rate6: 0n, renewWindow: 300, minExtension: 1801 }).refused, /^ExtensionTooShort/);
  assert.equal(renewalCadence({ leaseSec: 1800, rate6: 0n, renewWindow: 300, minExtension: 1800 }).refused, null);
});
