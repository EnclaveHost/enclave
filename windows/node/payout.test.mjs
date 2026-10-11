// Where the box's earnings go (payout.mjs): to the payout wallet changed FROM THIS MACHINE - a declaration on chain
// whose transaction carries the one-time code this node issued - and to nobody else. Driven with a fake chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Payouts, loadPayoutState, MIN_GAS_WEI, CODE_TTL_MS, declarationCalldata } from "./payout.mjs";

const OP = "0x389C3f030a209D04D026228D2D053fEB75DbadcA", MINE = "0x" + "a1".repeat(20), NEXT = "0x" + "b2".repeat(20), EVIL = "0x" + "e7".repeat(20);
const ID = "0x" + "11".repeat(32);
function fakeChain(o = {}) {
  const c = { declared: null, earned: 2_500_000n, gas: MIN_GAS_WEI * 10n, sent: [], block: 100n, decls: [], inputs: new Map(), fail: null, ...o };
  c.operatorAddress = () => OP;
  c.operatorBalance = async () => c.gas;
  c.readEnclave = async (id) => { if (c.fail) throw new Error(c.fail); assert.equal(id, ID); return { payoutWallet: c.declared ?? "0x0000000000000000000000000000000000000000" }; };
  c.earnedOf = async (a) => { assert.equal(a, OP); return c.earned; };
  c.withdrawEarnings = async (to) => { c.sent.push(to); c.earned = 0n; return "0x" + "77".repeat(32); };
  c.blockNumber = async () => c.block;
  c.payoutDeclarations = async (id, from) => { assert.equal(id, ID); return c.decls.filter((d) => d.blockNumber >= from); };
  c.txInput = async (h) => c.inputs.get(h);
  // a wallet declares itself; `code` is what the page appended (null: a plain setPayoutWallet, as from anywhere else)
  c.declare = (wallet, code, { wrap = false } = {}) => {
    c.block += 5n;
    const hash = "0x" + (c.decls.length + 1).toString(16).padStart(64, "0");
    const data = "d6a60cad" + ID.slice(2) + (code ? code.slice(2) : "");
    c.inputs.set(hash, "0x" + (wrap ? "6a761202" + "00".repeat(100) + data + "00".repeat(28) : data));   // a Safe nests it
    c.decls.push({ wallet, txHash: hash, blockNumber: c.block });
    c.declared = wallet;
    return hash;
  };
  return c;
}
const codeOf = (url) => /#code=(0x[0-9a-f]{64})$/.exec(url)[1];
function mk(chain, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-payout-")), logs = [];
  let t = 1_000_000;
  const p = new Payouts({ file: path.join(dir, "payout.json"), enclaveId: ID, chain, log: (m) => logs.push(m), now: () => t, ...extra });
  const fresh = () => { p.cache = null; };
  return { p, dir, logs, fresh, tick: (ms) => { t += ms; fresh(); } };
}
/** A payout wallet changed from this machine, the way the tray and the page do it. */
async function changeFromHere(chain, h, wallet, opts) {
  const { url } = await h.p.begin();
  chain.declare(wallet, codeOf(url), opts); h.fresh();
  return h.p.status();
}

test("nothing set pays nobody; a wallet declared from anywhere else is not adopted", async () => {
  const chain = fakeChain(); const h = mk(chain);
  let s = await h.p.status();
  assert.equal(s.readable, true); assert.equal(s.payTo, null); assert.equal(s.why, "no payout wallet is set");
  assert.equal(s.earned6, "2500000"); assert.equal(s.paidOut6, "0"); assert.equal(s.pending, null);
  chain.declare(MINE, null); h.fresh();                              // the CLI, the old page, or a stranger
  s = await h.p.status();
  assert.equal(s.confirmed, null); assert.match(s.why, /declared on chain for this box, but not from this machine/);
  assert.deepEqual(await h.p.payout({ now: true }), { paid: false, why: s.why }); assert.deepEqual(chain.sent, []);
});

test("a change started here is adopted on its own once the declaration carrying this machine's code lands", async () => {
  const chain = fakeChain(); const h = mk(chain);
  const { url, expiresAt } = await h.p.begin();
  assert.match(url, new RegExp(`^https://enclave\\.host/payout\\?id=${ID}#code=0x[0-9a-f]{64}$`));
  assert.equal(Date.parse(expiresAt), 1_000_000 + CODE_TTL_MS);
  let s = await h.p.status();
  assert.deepEqual(s.pending, { expiresAt }); assert.ok(!JSON.stringify(s).includes(codeOf(url).slice(2)), "the code never leaves in the status");
  assert.match(s.why, /no payout wallet is set; waiting for the declaration started from this machine/);
  const tx = chain.declare(MINE, codeOf(url)); h.fresh();
  s = await h.p.status();
  assert.equal(s.confirmed, MINE); assert.equal(s.payTo, MINE); assert.equal(s.confirmedTx, tx); assert.equal(s.pending, null); assert.equal(s.why, null);
  assert.ok(h.logs.some((l) => /payout wallet changed from this machine: 0xa1a1.*carrying this machine's code/.test(l)));
  assert.equal(loadPayoutState(path.join(h.dir, "payout.json")).confirmed, MINE, "it survives a restart");
  assert.equal((await h.p.payout({ now: true })).to, MINE);
});

test("the wallet changes WHILE HOSTING: earnings go to the new one from the moment its declaration lands", async () => {
  const chain = fakeChain(); const h = mk(chain);
  await changeFromHere(chain, h, MINE);
  assert.equal((await h.p.payout({ now: true })).to, MINE);
  chain.earned = 1_200_000n;
  const s = await changeFromHere(chain, h, NEXT);
  assert.equal(s.confirmed, NEXT);
  assert.equal((await h.p.payout()).to, NEXT);
  assert.deepEqual(chain.sent, [MINE, NEXT]);
  assert.equal((await h.p.status()).paidOut6, "3700000");
});

test("a stranger's declaration - in the window, with no code or a wrong one, or before the change began - is never adopted", async () => {
  const chain = fakeChain(); const h = mk(chain);
  await changeFromHere(chain, h, MINE);
  const before = chain.declare(EVIL, null);                          // before the next change starts
  const { url } = await h.p.begin();
  h.fresh(); assert.equal((await h.p.status()).confirmed, MINE);
  chain.declare(EVIL, null); h.fresh();
  let s = await h.p.status();
  assert.equal(s.confirmed, MINE); assert.equal(s.payTo, null);
  assert.match(s.why, /the chain now names 0xe7e7.*which was not set from this machine: payouts wait until the wallet is changed here; waiting/);
  chain.declare(EVIL, "0x" + "99".repeat(32)); h.fresh();            // a guessed code
  assert.equal((await h.p.status()).confirmed, MINE);
  assert.deepEqual((await h.p.payout({ now: true })).paid, false); assert.deepEqual(chain.sent, [], "nothing went anywhere");
  assert.ok(before);
  chain.declare(MINE, codeOf(url)); h.fresh();                       // the owner's own, from this machine
  s = await h.p.status();
  assert.equal(s.confirmed, MINE); assert.equal(s.payTo, MINE);
  assert.equal((await h.p.payout({ now: true })).to, MINE);
});

test("after a change lands, a stranger overwriting the declaration stops payouts; the spent code cannot be replayed", async () => {
  const chain = fakeChain(); const h = mk(chain);
  const { url } = await h.p.begin(); const code = codeOf(url);
  chain.declare(MINE, code); h.fresh(); await h.p.status();
  chain.declare(EVIL, code); h.fresh();                              // copied off the chain: the code is public once used
  const s = await h.p.status();
  assert.equal(s.confirmed, MINE); assert.equal(s.payTo, null); assert.match(s.why, /not set from this machine/);
  assert.equal((await h.p.payout({ now: true })).paid, false); assert.deepEqual(chain.sent, []);
});

test("the owner's declaration overwritten by a stranger BEFORE this node looked: the stranger is not adopted", async () => {
  const chain = fakeChain(); const h = mk(chain);
  const { url } = await h.p.begin();
  chain.declare(MINE, codeOf(url));
  chain.declare(EVIL, null); h.fresh();                              // the chain now names the stranger
  let s = await h.p.status();
  assert.equal(s.confirmed, null, "the code's transaction declared MINE, not what the chain names now"); assert.equal(s.payTo, null);
  chain.declare(MINE, null); h.fresh();                              // MINE again, without the code: still the code's wallet
  s = await h.p.status();
  assert.equal(s.confirmed, MINE, "the chain names the wallet whose declaration carried the code");
});

test("a code expires after 30 minutes; a new change voids the old code", async () => {
  const chain = fakeChain(); const h = mk(chain);
  const first = codeOf((await h.p.begin()).url);
  h.tick(CODE_TTL_MS + 1);
  assert.equal((await h.p.status()).pending, null);
  assert.ok(h.logs.some((l) => /expired before a declaration carrying its code arrived/.test(l)));
  chain.declare(MINE, first); h.fresh();
  assert.equal((await h.p.status()).confirmed, null, "a late declaration with an expired code is not adopted");
  const second = codeOf((await h.p.begin()).url);
  const third = codeOf((await h.p.begin()).url);
  assert.notEqual(second, third);
  chain.declare(MINE, second); h.fresh();
  assert.equal((await h.p.status()).confirmed, null, "the code a newer change replaced is void");
  chain.declare(MINE, third); h.fresh();
  assert.equal((await h.p.status()).confirmed, MINE);
});

test("a contract wallet (Safe) nests the calldata: still found; clear pays nobody and voids a change in progress", async () => {
  const chain = fakeChain(); const h = mk(chain);
  assert.equal((await changeFromHere(chain, h, MINE, { wrap: true })).confirmed, MINE);
  await h.p.begin();
  const s = await h.p.clear();
  assert.equal(s.confirmed, null); assert.equal(s.pending, null); assert.equal(s.payTo, null);
  assert.equal((await h.p.payout({ now: true })).paid, false); assert.deepEqual(chain.sent, []);
});

test("pays at the minimum on its own, any amount on request; recorded and summed", async () => {
  const chain = fakeChain({ earned: 400_000n }); const h = mk(chain);
  await changeFromHere(chain, h, MINE);
  const small = await h.p.payout();
  assert.equal(small.paid, false); assert.match(small.why, /\$0\.40 earned; paid out automatically from \$1\.00/);
  const now = await h.p.payout({ now: true });
  assert.equal(now.paid, true); assert.equal(now.amount6, "400000");
  chain.earned = 1_500_000n;
  assert.equal((await h.p.payout()).paid, true, "from $1 it goes on its own");
  const s = await h.p.status();
  assert.equal(s.paidOut6, "1900000"); assert.equal(s.history.length, 2); assert.equal(s.history[0].amount6, "1500000", "newest first");
  assert.equal((await h.p.payout({ now: true })).paid, false, "nothing left: nothing sent");
  assert.equal(chain.sent.length, 2);
});

test("pays nobody when the chain cannot be read, the operator is short of gas, or the wallet IS the operator", async () => {
  const chain = fakeChain(); const h = mk(chain);
  await changeFromHere(chain, h, MINE);
  chain.fail = "rpc down"; h.fresh();
  const s = await h.p.status();
  assert.equal(s.readable, false); assert.match(s.why, /could not be read: rpc down/);
  const r = await h.p.payout({ now: true });
  assert.equal(r.paid, false); assert.match(r.why, /rpc down/);
  chain.fail = null; chain.gas = MIN_GAS_WEI - 1n;
  assert.match((await h.p.payout({ now: true })).why, /low on gas/);
  chain.gas = MIN_GAS_WEI;
  await changeFromHere(chain, h, OP);
  assert.match((await h.p.payout({ now: true })).why, /operator key, which already holds the earnings/);
  assert.deepEqual(chain.sent, []);
});

test("a failed look for the declaration is said and retried, never fatal", async () => {
  const chain = fakeChain(); const h = mk(chain);
  const { url } = await h.p.begin();
  chain.declare(MINE, codeOf(url));
  const real = chain.payoutDeclarations; chain.payoutDeclarations = async () => { throw new Error("logs range too wide"); }; h.fresh();
  const s = await h.p.status();
  assert.equal(s.readable, true); assert.equal(s.confirmed, null); assert.match(s.lastError, /logs range too wide/);
  chain.payoutDeclarations = real; h.fresh();
  assert.equal((await h.p.status()).confirmed, MINE);
});

test("one payout at a time", async () => {
  const chain = fakeChain(); let release;
  chain.withdrawEarnings = (to) => new Promise((r) => { release = () => r("0x" + "88".repeat(32)); chain.sent.push(to); });
  const h = mk(chain);
  await changeFromHere(chain, h, MINE);
  const first = h.p.payout({ now: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(await h.p.payout({ now: true }), { paid: false, why: "a payout is already being sent" });
  release(); assert.equal((await first).paid, true); assert.equal(chain.sent.length, 1);
});

test("declarationCalldata is setPayoutWallet(id) followed by the code", () => {
  assert.equal(declarationCalldata(ID, "0x" + "ab".repeat(32)), "d6a60cad" + "11".repeat(32) + "ab".repeat(32));
});
