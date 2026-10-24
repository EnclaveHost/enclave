// lib/proposer.mjs against a two-RPC fake of Base (test/helpers/fake-base.mjs) with a TEST key: authority, code, fees,
// caps, nonce races, the journal-before-broadcast barrier, crash/unknown outcomes, rejection, restart with the same
// bytes, and receipt verification. No network, no real key: the production key file is never read here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createProposer, checkPublicPlan, PRODUCTION, txSizes, assertCoversSigned, ORACLE_SIGNATURE_ALLOWANCE } from "../lib/proposer.mjs";
import { fakeBase, RPC_B, l1UpperBound } from "./helpers/fake-base.mjs";
import { serializeTransaction } from "viem";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAN = fs.readFileSync(path.join(HERE, "fixtures/metal0-enrollment-unsigned-20261023.json"), "utf8");

function world({ polls = 6, mineOnPoll = true } = {}) {
  const key = generatePrivateKey(), acct = privateKeyToAccount(key);
  const f = fakeBase({ operator: acct.address.toLowerCase() });
  const deployed = f.s.ownershipCode, executor = f.s.executorCode;   // the fake's "deployed" bytecode stands for the reviewed hashes
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-propose-"));
  let keyReads = 0, clock = Date.now();
  const cfg = { ...PRODUCTION, operator: acct.address.toLowerCase(), rpcs: f.RPCS, receiptPolls: polls, pollMs: 0 };
  const mk = (over = {}) => createProposer({ cfg, rpc: f.rpc, dir, now: () => clock, sleep: async () => { if (mineOnPoll) f.mine(1); },
    readKey: async () => { keyReads++; return key; }, codeHashOf: (c) => (c === deployed ? PRODUCTION.ownershipCodeHash : c === executor ? PRODUCTION.delegationTargetCodeHash : keccak256(c)), ...over });
  return { f, dir, mk, key, acct, keyReads: () => keyReads, advance: (ms) => { clock += ms; }, journal: () => path.join(dir, "journal") };
}
const prepared = async (w, p = w.mk()) => { const r = await p.prepare({ planText: PLAN }); assert.equal(r.status, "prepared", JSON.stringify(r)); return r; };
const code = (re) => (e) => { assert.equal(e.code, re, e.message); return true; };

test("the public plan and the production constants agree; no other target can be configured", () => {
  assert.equal(keccak256(PRODUCTION.operatorDelegation), PRODUCTION.operatorDelegationCodeHash, "the pinned 7702 designator hashes to root's delegationCodeHash");
  assert.equal(PRODUCTION.operatorDelegation, "0xef0100" + PRODUCTION.delegationTarget.slice(2), "the designator names the pinned executor");
  assert.ok(checkPublicPlan(PLAN));
  assert.throws(() => checkPublicPlan(PLAN.replace("0x0b2d009c", "0x0b2d009d")), code("plan_file"));
  const w = world();
  for (const [k, v] of [["ownership", "0x" + "11".repeat(20)], ["proposed", "0x" + "22".repeat(20)], ["hostId", "0x" + "33".repeat(32)],
    ["data", PRODUCTION.data.slice(0, -2) + "00"], ["oracle", "0x" + "44".repeat(20)], ["delegationTarget", "0x" + "55".repeat(20)], ["delegationTargetCodeHash", "0x" + "66".repeat(32)]])
    assert.throws(() => w.mk({ cfg: { ...PRODUCTION, [k]: v, rpcs: w.f.RPCS } }), /production value/, k);
  assert.throws(() => w.mk({ cfg: { ...PRODUCTION, rpcs: w.f.RPCS, caps: { ...PRODUCTION.caps, totalWei: 10n ** 18n } } }), /production value/);
  assert.throws(() => w.mk({ cfg: { ...PRODUCTION, rpcs: [w.f.RPCS[0], w.f.RPCS[0]] } }), /two distinct/);
});

test("prepare: exact proposeOwner fields under the caps, public plan, no key read", async () => {
  const w = world();
  const { planHash, plan } = await prepared(w);
  assert.deepEqual([plan.tx.to, plan.tx.data, plan.tx.value, plan.tx.nonce, plan.tx.chainId, plan.tx.from],
                   [PRODUCTION.ownership, PRODUCTION.data, "0", "7", 8453, w.acct.address.toLowerCase()]);
  assert.ok(BigInt(plan.tx.gas) <= 150_000n && BigInt(plan.tx.maxFeePerGas) <= 100_000_000n);
  assert.ok(BigInt(plan.observed.fees.totalAtBlockWei) <= 5_000_000_000_000n);
  assert.equal(plan.observed.balanceSufficient, true);
  assert.equal(fs.readFileSync(path.join(w.dir, "prepared/current"), "utf8").trim(), planHash);
  assert.equal(w.keyReads(), 0);
  assert.equal(w.f.s.sent.length, 0);
  // an unfunded operator still gets a plan, with the exact funding gap
  const w2 = world(); w2.f.s.balance = 0n;
  const r2 = await prepared(w2);
  assert.equal(r2.plan.observed.balanceSufficient, false);
  assert.equal(r2.plan.observed.fundingNeededWei, r2.plan.observed.fees.totalAtBlockWei);
});

test("prepare refuses wrong code, authority, host entry or operator state", async () => {
  const cases = [
    ["ownership_code", (s) => { s.ownershipCode = "0xbad0"; }],
    ["ownership_registry", (s) => { s.registry = "0x" + "77".repeat(20); }],
    ["host_entry", (s) => { s.host.active = false; }],
    ["host_entry", (s) => { s.host.operator = "0x" + "88".repeat(20); }],
    ["host_entry", (s) => { s.host.payout = "0x" + "99".repeat(20); }],
    ["host_entry", (s) => { s.host.endpoint = "https://api.enclave.host/t/metal1"; }],
    ["host_entry", (s) => { s.registryCode = "0x"; }],
    ["authority", (s) => { s.authority.owner = "0x" + "aa".repeat(20); }],
    ["authority", (s) => { s.authority.pendingOwner = "0x" + "bb".repeat(20); }],
    ["authority", (s) => { s.authority.pendingOwner = PRODUCTION.proposed; }],      // pending, but not from a verified journal
    ["operator", (s) => { s.operatorCode = "0x"; }],                                          // delegation removed
    ["operator", (s) => { s.operatorCode = "0xef0100" + "77".repeat(20); }],                  // re-delegated elsewhere
    ["operator", (s) => { s.operatorCode = "0x6000"; }],                                      // other code
    ["operator", (s) => { s.executorCode = "0x5fe2"; }],                                      // executor runtime changed
  ];
  for (const [c, mutate] of cases) {
    const w = world(); mutate(w.f.s);
    await assert.rejects(w.mk().prepare({ planText: PLAN }), code(c), c);
    assert.equal(w.f.s.sent.length, 0);
  }
  const w = world(); w.f.s.authority.owner = PRODUCTION.proposed;
  assert.equal((await w.mk().prepare({ planText: PLAN })).status, "accepted", "already accepted: nothing to do");
});

test("two RPCs must agree; an RPC error is never read as absence", async () => {
  const w1 = world();
  w1.f.s.hooks.eth_call = (url, params, a) => (url === RPC_B && params[0].data.startsWith("0x8bcbb4c8") ? a.slice(0, -1) + "1" : a);
  await assert.rejects(w1.mk().prepare({ planText: PLAN }), code("rpc_disagree"));
  const w2 = world();
  w2.f.s.hooks.eth_getBlockByNumber = (url, params, a) => (url === RPC_B && params[0] !== "latest" ? { ...a, hash: "0x" + "ee".repeat(32) } : a);
  await assert.rejects(w2.mk().prepare({ planText: PLAN }), code("rpc_disagree"));
  const w4 = world();
  w4.f.s.hooks.eth_getCode = (url, params, a) => (url === RPC_B && params[0] === PRODUCTION.delegationTarget ? "0x5fe3" : a);
  await assert.rejects(w4.mk().prepare({ planText: PLAN }), code("rpc_disagree"), "the RPCs must agree on the executor code");
  const w3 = world();
  w3.f.s.hooks.eth_call = (url, params, a) => { if (url === RPC_B) throw new Error("rpc-b: 503"); return a; };
  await assert.rejects(w3.mk().prepare({ planText: PLAN }), /503/);
});

test("fees, gas, the Base L1 fee and the total stay under the caps; an unsettled nonce refuses", async () => {
  for (const [c, mutate] of [["fees", (s) => { s.baseFee = 60_000_000n; }], ["gas", (s) => { s.estimate = 130_000n; }],
    ["cap", (s) => { s.l1PerByte = 30_000_000_000n; }], ["cap", (s) => { s.baseFee = 40_000_000n; s.estimate = 110_000n; }],
    ["nonce", (s) => { s.pool.push({ hash: "0x01", from: "", to: "", data: "0x", nonce: 7, gas: 1 }); }]]) {
    const w = world(); mutate(w.f.s);
    if (c === "nonce") w.f.s.pool[0].from = w.acct.address.toLowerCase();
    await assert.rejects(w.mk().prepare({ planText: PLAN }), code(c), c);
  }
});

test("send refuses before reading the key: flag, plan hash, stale plan, moved nonce, fees, balance", async () => {
  const cases = [
    ["confirm", async (w, h) => ({ planHash: h, confirm: false })],
    ["plan_hash", async (w, h) => ({ planHash: "0x" + "00".repeat(32), confirm: true })],
    ["plan_hash", async (w, h) => { w.advance(1); await prepared(w); return { planHash: h, confirm: true }; }],   // no longer current
    ["stale_plan", async (w, h) => { w.advance(2 * 3600_000); return { planHash: h, confirm: true }; }],
    ["nonce", async (w, h) => { w.f.s.nonce++; return { planHash: h, confirm: true }; }],
    ["fees", async (w, h) => { w.f.s.baseFee = 30_000_000n; return { planHash: h, confirm: true }; }],
    ["balance", async (w, h) => { w.f.s.balance = 1000n; return { planHash: h, confirm: true }; }],
    ["authority", async (w, h) => { w.f.s.authority.pendingOwner = "0x" + "bb".repeat(20); return { planHash: h, confirm: true }; }],
    ["plan_hash", async (w, h) => { const f = path.join(w.dir, "prepared", `${h}.json`); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"gas": "', '"gas": "1')); return { planHash: h, confirm: true }; }],
  ];
  for (const [c, setup] of cases) {
    const w = world(); const p = w.mk(); const { planHash } = await prepared(w, p);
    const args = await setup(w, planHash);
    await assert.rejects(p.send({ ...args, planText: PLAN }), code(c), c);
    assert.equal(w.keyReads(), 0, `${c}: the key was read`);
    assert.equal(w.f.s.sent.length, 0);
    assert.equal(fs.existsSync(w.journal()) ? fs.readdirSync(w.journal()).length : 0, 0, `${c}: nothing journaled`);
  }
});

test("a key of another address signs nothing", async () => {
  const w = world(); const p = w.mk({ readKey: async () => generatePrivateKey() });
  const { planHash } = await prepared(w, p);
  await assert.rejects(p.send({ planHash, confirm: true, planText: PLAN }), code("key"));
  assert.equal(w.f.s.sent.length, 0);
  assert.equal(fs.existsSync(w.journal()) ? fs.readdirSync(w.journal()).length : 0, 0);
});

test("send: the signed bytes are journaled (0600, fsynced) BEFORE broadcast; verified receipt; nothing secret in the output; never twice", async () => {
  const w = world(); const p = w.mk(); const { planHash } = await prepared(w, p);
  const seen = [];
  w.f.s.onBroadcast = async (url, raw) => {
    const file = path.join(w.journal(), `${planHash}.json`);
    assert.ok(fs.existsSync(file), "journal exists at broadcast");
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(rec.raw, raw, "the journaled bytes are the broadcast bytes");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(w.journal()).mode & 0o777, 0o700);
    seen.push(url);
  };
  const out = await p.send({ planHash, confirm: true, planText: PLAN });
  assert.equal(out.status, "verified", JSON.stringify(out));
  assert.deepEqual(seen, w.f.RPCS, "the same bytes to both RPCs");
  assert.equal(new Set(w.f.s.sent.map((x) => x.hash)).size, 1);
  assert.equal(out.txHash, w.f.s.sent[0].hash);
  assert.ok(BigInt(out.receipt.confirmationsAtCheck) >= 2n);
  assert.equal(out.receipt.authorityAfter.pendingOwner, PRODUCTION.proposed);
  const text = JSON.stringify(out);
  assert.ok(!text.includes(w.f.s.sent[0].raw.slice(2, 60)) && !text.includes(w.key.slice(2)), "neither the raw transaction nor the key is in the output");
  assert.equal(w.keyReads(), 1);
  await assert.rejects(p.send({ planHash, confirm: true, planText: PLAN }), code("journal"), "never signs twice");
  assert.equal((await w.mk().prepare({ planText: PLAN })).status, "proposed", "the verified journal explains the pending owner");
});

test("a journal write failure broadcasts nothing", async () => {
  const w = world();
  const failing = { ...fs, linkSync: () => { throw new Error("EIO: disk"); } };
  const p = w.mk({ fsImpl: failing }); const { planHash } = await prepared(w, p);
  await assert.rejects(p.send({ planHash, confirm: true, planText: PLAN }), /EIO/);
  assert.equal(w.f.s.sent.length, 0);
  assert.equal(fs.readdirSync(w.journal()).filter((f) => f.endsWith(".json")).length, 0);
});

test("crash after the journal, before any broadcast landed: restart never re-signs; --rebroadcast sends the SAME bytes", async () => {
  const w = world({ polls: 6, mineOnPoll: false }); const p = w.mk(); const { planHash } = await prepared(w, p);
  w.f.s.onBroadcast = async () => { throw new Error("connection reset"); };            // nothing reached the chain
  const out = await p.send({ planHash, confirm: true, planText: PLAN });
  assert.equal(out.status, "unknown");
  const journaled = JSON.parse(fs.readFileSync(path.join(w.journal(), `${planHash}.json`), "utf8"));
  // restart: a new process
  w.f.s.onBroadcast = null;
  const q = w.mk();
  await assert.rejects(q.send({ planHash, confirm: true, planText: PLAN }), code("journal"));
  const r1 = await q.resume({ planHash });
  assert.equal(r1.status, "pending"); assert.equal(w.f.s.sent.length, 0, "resume without --rebroadcast sends nothing");
  const q2 = w.mk({ sleep: async () => w.f.mine(1) });
  const r2 = await q2.resume({ planHash, rebroadcast: true });
  assert.equal(r2.status, "verified", JSON.stringify(r2));
  assert.ok(w.f.s.sent.every((x) => x.raw === journaled.raw && x.hash === journaled.txHash), "only the journaled bytes");
  assert.equal(w.keyReads(), 1, "the key was read once, by the first send");
});

test("unknown outcome: the RPC times out but the transaction landed; resume verifies it without sending", async () => {
  const w = world({ polls: 1, mineOnPoll: false }); const p = w.mk(); const { planHash } = await prepared(w, p);
  w.f.s.hooks.eth_sendRawTransaction = () => { throw new Error("timeout"); };            // delivered, answer lost
  assert.equal((await p.send({ planHash, confirm: true, planText: PLAN })).status, "unknown");
  const sends = w.f.s.sent.length;
  w.f.mine(3);
  const r = await w.mk().resume({ planHash });
  assert.equal(r.status, "verified", JSON.stringify(r));
  assert.equal(w.f.s.sent.length, sends); assert.equal(w.keyReads(), 1);
});

test("a rejected broadcast, then the nonce used elsewhere: conflict, nothing re-signed or re-sent", async () => {
  const w = world({ polls: 1, mineOnPoll: false }); const p = w.mk(); const { planHash } = await prepared(w, p);
  w.f.s.onBroadcast = async () => { throw new Error("insufficient funds for gas * price + value"); };
  assert.equal((await p.send({ planHash, confirm: true, planText: PLAN })).status, "unknown");
  w.f.s.onBroadcast = null;
  w.f.s.nonce++; w.f.mine(1);                                                           // another transaction took nonce 7
  const r = await w.mk().resume({ planHash, rebroadcast: true });
  assert.equal(r.status, "conflict", JSON.stringify(r));
  assert.equal(w.f.s.sent.length, 0); assert.equal(w.keyReads(), 1);
  assert.equal((await w.mk().resume({ planHash, rebroadcast: true })).status, "conflict", "conflict is final");
});

test("--rebroadcast refuses while the RPCs disagree on whether the journaled nonce is still unused", async () => {
  const w = world({ polls: 1, mineOnPoll: false }); const p = w.mk(); const { planHash } = await prepared(w, p);
  w.f.s.onBroadcast = async () => { throw new Error("connection reset"); };
  assert.equal((await p.send({ planHash, confirm: true, planText: PLAN })).status, "unknown");
  w.f.s.onBroadcast = null;
  w.f.s.hooks.eth_getTransactionCount = (url, params, a) => (url === RPC_B && params[1] === "latest" ? "0x" + (BigInt(a) + 1n).toString(16) : a);
  await assert.rejects(w.mk().resume({ planHash, rebroadcast: true }), code("nonce"));
  assert.equal(w.f.s.sent.length, 0, "nothing re-sent");
});

test("receipt verification: disagreeing RPCs, too few confirmations and a revert are not success", async () => {
  // RPC B reports another block for the receipt until it agrees
  const w = world({ polls: 3 }); const p = w.mk(); const { planHash } = await prepared(w, p);
  let lie = true;
  w.f.s.hooks.eth_getTransactionReceipt = (url, params, a) => (url === RPC_B && a && lie ? { ...a, blockHash: "0x" + "dd".repeat(32) } : a);
  assert.equal((await p.send({ planHash, confirm: true, planText: PLAN })).status, "unknown", "never verified while the RPCs disagree");
  lie = false;
  assert.equal((await w.mk().resume({ planHash })).status, "verified");
  // a revert (the host went inactive before it was mined)
  const v = world({ polls: 4, mineOnPoll: false }); const pv = v.mk(); const pr = await prepared(v, pv);
  v.f.s.onBroadcast = async () => { v.f.s.host.active = false; };
  const sending = pv.send({ planHash: pr.planHash, confirm: true, planText: PLAN });
  const out = await sending.then((x) => x);
  assert.equal(out.status, "unknown");
  v.f.mine(1);
  const r1 = await v.mk().resume({ planHash: pr.planHash });
  assert.equal(r1.status, "pending", "one confirmation is not enough");
  v.f.mine(2);
  const r2 = await v.mk().resume({ planHash: pr.planHash });
  assert.equal(r2.status, "failed"); assert.match(r2.note, /reverted/);
});

test("the CLI accepts only its own flags and one mode (no chain, no key)", () => {
  const bin = path.join(HERE, "../bin/operator-propose.mjs");
  for (const args of [["--to", "0x00"], ["--send", "--resume"], ["--value", "1"]]) {
    const r = spawnSync(process.execPath, [bin, ...args, "--dir", fs.mkdtempSync(path.join(os.tmpdir(), "op-cli-"))], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(r.status, 64, `${args}: ${r.stderr}`);
  }
});

const txOf = (plan, nonce = Number(plan.tx.nonce)) => ({ type: "eip1559", chainId: 8453, nonce, to: PRODUCTION.ownership, value: 0n, data: PRODUCTION.data,
  gas: BigInt(plan.tx.gas), maxFeePerGas: BigInt(plan.tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(plan.tx.maxPriorityFeePerGas) });
const bytesOf = (tx) => (serializeTransaction(tx).length - 2) / 2;

test("L1 fee: sized with the REAL nonce and the maximum signed encoding; the old nonce-0 sizing undercounts and is refused", async () => {
  const w = world(); w.f.s.nonce = 23759;
  const { plan } = await prepared(w);
  assert.equal(plan.tx.nonce, "23759");
  const e = plan.observed.fees.encodedBytes;
  assert.equal(e.unsigned, bytesOf(txOf(plan)), "the unsigned size is the exact transaction's, real nonce included");
  const nonce0 = bytesOf(txOf(plan, 0));
  assert.equal(e.unsigned - nonce0, 2, "nonce 23759 encodes in 2 more bytes than nonce 0");
  assert.equal(e.signedMax - e.unsigned, 67, "yParity + 33-byte r + 33-byte s");
  assert.deepEqual(txSizes(txOf(plan)), { unsigned: e.unsigned, signedMax: e.signedMax, argument: e.oracleArgument });
  assert.ok(e.oracleArgument + ORACLE_SIGNATURE_ALLOWANCE >= e.signedMax, "the oracle-side size covers the maximum signed transaction");
  assert.equal(w.f.s.oracleArgs.at(-1), BigInt(e.oracleArgument), "the oracle was asked for exactly that size");
  assert.equal(BigInt(plan.observed.fees.l1DataUpperBoundWei), l1UpperBound(e.oracleArgument, w.f.s.l1PerByte));
  // the previous code passed the nonce-0 unsigned size: with the oracle's 68 bytes it still misses the signed maximum
  assert.throws(() => assertCoversSigned({ argument: nonce0, signedMax: e.signedMax }), /undercounts the signed transaction/);
  assert.throws(() => assertCoversSigned({ argument: e.signedMax - ORACLE_SIGNATURE_ALLOWANCE - 1, signedMax: e.signedMax }), /undercounts/);
  assert.doesNotThrow(() => assertCoversSigned(txSizes(txOf(plan))));
  // a signature overhead above the allowance raises the argument instead of undercounting
  const big = txSizes({ ...txOf(plan), data: "0x" + "ab".repeat(4000) });
  assert.ok(big.argument >= big.unsigned && big.argument + ORACLE_SIGNATURE_ALLOWANCE >= big.signedMax);
});

test("operator fee: the oracle's fee for the gas LIMIT is part of the total; an undetermined operator fee blocks the plan and the send", async () => {
  const w = world(); const p = w.mk(); const { planHash, plan } = await prepared(w, p);
  const f = plan.observed.fees, gas = BigInt(plan.tx.gas);
  assert.equal(w.f.s.operatorArgs.at(-1), gas, "evaluated for the gas limit, not the estimate");
  assert.equal(BigInt(f.operatorFeeUpperBoundWei), gas * w.f.s.operatorScalar + w.f.s.operatorConstant);
  assert.equal(BigInt(f.totalAtBlockWei), BigInt(f.l2MaxWei) + BigInt(f.l1DataUpperBoundWei) + BigInt(f.operatorFeeUpperBoundWei));
  assert.match(f.note, /operator fee for the gas limit/); assert.equal(plan.observed.totalMaxWei, undefined, "no field claims an all-fee maximum");
  for (const [c, mutate] of [["operator_fee", (s) => { s.isthmus = false; }], ["operator_fee", (s) => { s.isthmus = "revert"; }],
    ["cap", (s) => { s.operatorConstant = 5_000_000_000_000n; }]]) {
    const v = world(); mutate(v.f.s);
    await assert.rejects(v.mk().prepare({ planText: PLAN }), code(c), c);
  }
  const d = world();
  d.f.s.hooks.eth_call = (url, params, a) => (url === RPC_B && String(params[0].data).startsWith("0x275aedd2") ? a.slice(0, -1) + "f" : a);
  await assert.rejects(d.mk().prepare({ planText: PLAN }), code("rpc_disagree"));
  // --send re-reads it: an operator fee that became undetermined refuses before the key is read
  w.f.s.isthmus = false;
  await assert.rejects(p.send({ planHash, confirm: true, planText: PLAN }), code("operator_fee"));
  assert.equal(w.keyReads(), 0); assert.equal(w.f.s.sent.length, 0);
});
