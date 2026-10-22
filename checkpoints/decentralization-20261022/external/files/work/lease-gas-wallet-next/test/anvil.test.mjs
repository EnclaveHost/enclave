// Stages 2 and 3 against a real anvil chain (chain id 8453) with the frozen compiled reserve/executor, the real admin
// address by impersonation (no key), two provider hosts (127.0.0.1 and a forwarder reached as localhost), root's
// request shape and root's verifyReserve for step 1, and the stage servers on root's own handoff transport.
//   run: node --test --test-concurrency=1 test/anvil.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeDeployData, getContractAddress, keccak256, toHex } from "../../enclave/node_modules/viem/_esm/index.js";
import { verifyReserve } from "../verify-reserve.mjs";
import { prepareExecutorRequest, verifyExecutor, prepareBindRequest, verifyBinding, RESERVE_ABI } from "../stages.mjs";
import { stageApp } from "../stage-app.mjs";
import { fileJournal } from "../handoff-server.mjs";
import { PRODUCTION } from "../trust.mjs";
import { startChain, baseLike, reserveStep, walletSend, asAdmin, returning } from "./fixture.mjs";

let chain, trust, artifacts, req1, h1, reserve, base, req2, h2, executor, tmp;
const opened = new Set();   // every stage server a test starts is closed even when an assertion fails
const T = { timeout: 120000 };
const send = (tx, o) => walletSend(chain, { from: tx.from, ...(tx.to ? { to: tx.to } : {}), nonce: tx.nonce, data: tx.data, value: tx.value, gas: tx.gas,
  maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, type: "0x2", chainId: "0x2105", ...o?.override }, o);
// anvil's evm_revert consumes the snapshot (and later ones): revert to the post-step-1 state and re-take it at once
// (anvil's next-block base-fee override survives evm_revert: it is reset here so one case's fee change cannot leak)
const fromReserve = async () => { assert.equal(await chain.rpc("evm_revert", [base]), true); base = await chain.rpc("evm_snapshot");
  await chain.rpc("anvil_setNextBlockBaseFeePerGas", [toHex(5_000_000n)]); };
const at = async (_state, fn) => { await fromReserve(); await fn(); };
/** The chain right after a verified step 2 (rebuilt from the step-1 state). */
const fromExecutor = async () => {
  await fromReserve();
  const r = await prepareExecutorRequest(executorArgs()), h = await send(r.transaction);
  return { r, h, executor: (await verifyExecutor({ trust, request: r, hash: h, clients: chain.clients })).address };
};
const ctx = () => ({ trust, artifacts, clients: chain.clients });
const executorArgs = () => ({ ...ctx(), reserveRequest: req1, reserveHash: h1 });

before(async () => {
  chain = await startChain();
  ({ trust, artifacts } = await baseLike(chain));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lease-next-"));
});
after(async () => { for (const a of opened) await a.close().catch(() => {}); chain?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test("step 1 (root's request shape) lands and root's verifyReserve accepts it on two provider hosts", T, async () => {
  req1 = await reserveStep(chain, { trust, artifacts });
  h1 = await send(req1.transaction);
  const v = await verifyReserve({ request: req1, hash: h1, clients: chain.clients });
  reserve = v.address;
  assert.equal(v.executor, "0x0000000000000000000000000000000000000000"); assert.equal(v.fundingReady, false);
  base = await chain.rpc("evm_snapshot");
});

test("step 2: the exact executor request for the ACTUAL reserve, simulated with exact runtime/immutables; the landing verifies on both hosts", T, async () => {
  req2 = await prepareExecutorRequest(executorArgs());
  assert.equal(req2.stage, "executor"); assert.equal(req2.reserve.address.toLowerCase(), reserve.toLowerCase());
  assert.equal(BigInt(req2.transaction.nonce), BigInt(req1.transaction.nonce) + 1n);
  assert.equal(req2.transaction.value, "0x0"); assert.equal(req2.transaction.to, undefined);
  assert.ok(BigInt(req2.transaction.gas) <= trust.caps.executorGas && BigInt(req2.transaction.maxFeePerGas) <= trust.caps.maxFeePerGas);
  assert.match(req2.predictedAddressWarning, /NOT a funding destination/);
  h2 = await send(req2.transaction);
  const v = await verifyExecutor({ trust, request: req2, hash: h2, clients: chain.clients });
  executor = v.address;
  assert.equal(v.status, "executor creation verified; not yet bound"); assert.equal(v.fundingReady, false);
  // the immutable mapping (reserve, ledger, SELF) is confirmed by the real deployment, byte for byte
  assert.equal((await chain.clients[0].getCode({ address: executor })).toLowerCase(), req2.expectedRuntime.toLowerCase());
});

test("step 3: bind once; all three steps verified; only now is the reserve a funding destination", T, async () => {
  const req3 = await prepareBindRequest({ ...executorArgs(), executorRequest: req2, executorHash: h2 });
  assert.equal(req3.transaction.to.toLowerCase(), reserve.toLowerCase()); assert.equal(req3.transaction.value, "0x0");
  const h3 = await send(req3.transaction);
  const v = await verifyBinding({ trust, request: req3, hash: h3, clients: chain.clients });
  assert.equal(v.setupVerified, true); assert.equal(v.fundingDestination, reserve.toLowerCase()); assert.equal(v.executor, executor.toLowerCase());
  assert.equal(v.owner, trust.admin.toLowerCase(), "admin authority intact");
  // a second binding is impossible and is not offered
  await assert.rejects(prepareBindRequest({ ...executorArgs(), executorRequest: req2, executorHash: h2 }), /already bound/);
  await assert.rejects(prepareExecutorRequest(executorArgs()), /already bound/);
});

test("a reserve that was never deployed, or a predicted/other address, is never accepted as the reserve", T, async () => {
  await at(base, async () => {
    await assert.rejects(prepareExecutorRequest({ ...executorArgs(), reserveHash: "0x" + "ab".repeat(32) }));                       // no such transaction
    await assert.rejects(prepareExecutorRequest({ ...executorArgs(), reserveRequest: { ...req1, predictedAddress: getContractAddress({ from: trust.admin, nonce: BigInt(req1.transaction.nonce) + 1n }) } }), /wrong deployed address/);
    await assert.rejects(prepareExecutorRequest({ ...executorArgs(), reserveRequest: { ...req1, expectedRuntimeHash: keccak256("0x00") } }), /unexpected runtime/);
    const fresh = await reserveStep(chain, { trust, artifacts });                       // a creation request that is not sent
    await assert.rejects(prepareExecutorRequest({ ...executorArgs(), reserveRequest: fresh }));
  });
});

test("receipt depth, pending nonce, authority drift, fees and balance are refreshed and refused", T, async () => {
  await at(base, async () => {
    const r = await prepareExecutorRequest(executorArgs());
    const h = await send(r.transaction, { mine: 0 });                                 // one block only
    await assert.rejects(verifyExecutor({ trust, request: r, hash: h, clients: chain.clients }), /two later blocks/);
  });
  await at(base, async () => {
    await chain.rpc("evm_setAutomine", [false]);
    try {
      await chain.rpc("eth_sendTransaction", [{ from: trust.admin, to: trust.admin, value: "0x1" }]);
      await assert.rejects(prepareExecutorRequest(executorArgs()), /pending/);
    } finally { await chain.rpc("evm_setAutomine", [true]); }
  });
  const drift = [
    ["book owner", () => chain.rpc("anvil_setCode", [trust.book, returning("0x" + "11".repeat(20))]), /address book's owner/],
    ["ledger code", () => chain.rpc("anvil_setCode", [trust.ledger, "0x600960005260206000f3"]), /original ledger code/],
    ["reserve ownership transfer", () => asAdmin(chain, reserve, [...RESERVE_ABI, { type: "function", name: "transferOwnership", inputs: [{ type: "address" }], outputs: [], stateMutability: "nonpayable" }], "transferOwnership", ["0x" + "22".repeat(20)]), /ownership transfer is pending/],
    ["reserve paused", () => asAdmin(chain, reserve, [{ type: "function", name: "setPaused", inputs: [{ type: "bool" }], outputs: [], stateMutability: "nonpayable" }], "setPaused", [true]), /paused/],
    ["fees above the cap", async () => { await chain.rpc("anvil_setNextBlockBaseFeePerGas", [toHex(10_000_000_000n)]); await chain.rpc("anvil_mine", ["0x4"]); }, /fee exceeds/],
    ["balance", () => chain.rpc("anvil_setBalance", [trust.admin, "0x3e8"]), /balance does not cover/],
  ];
  for (const [name, change, pattern] of drift)
    await at(base, async () => { await change(); await chain.rpc("anvil_mine", ["0x3"]); await assert.rejects(prepareExecutorRequest(executorArgs()), pattern, name); });
});

test("a landing that differs from the request in sender, nonce, value, code or fees is refused", T, async () => {
  const variants = [
    ["fee raised by the wallet", (tx) => ({ override: { maxFeePerGas: toHex(BigInt(tx.maxFeePerGas) + 1n) } }), /increased fee cap/],
    ["gas changed", (tx) => ({ override: { gas: toHex(BigInt(tx.gas) + 1n) } }), /gas changed/],
    ["value sent", () => ({ override: { value: "0x1" } }), null, false],                        // a non-payable constructor reverts (or the node refuses)
    ["code for another reserve", (tx) => ({ override: { data: encodeDeployData({ abi: artifacts.EnclaveLeaseExecutor.abi, bytecode: artifacts.EnclaveLeaseExecutor.bytecode, args: [trust.ledger] }) } }), null],
  ];
  for (const [name, change, pattern, mustLand = true] of variants) {
    await at(base, async () => {
      const r = await prepareExecutorRequest(executorArgs());
      let h;
      try { h = await send(r.transaction, change(r.transaction)); } catch (e) { assert.ok(!mustLand, `${name}: the variant must land (${e.message})`); return; }
      await assert.rejects(verifyExecutor({ trust, request: r, hash: h, clients: chain.clients }), pattern || /./, name);
    });
  }
  await at(base, async () => {                                                         // another nonce: an unrelated admin tx went first
    const r = await prepareExecutorRequest(executorArgs());
    await walletSend(chain, { from: trust.admin, to: trust.admin, value: "0x1" });
    const h = await send(r.transaction, { override: { nonce: toHex(BigInt(r.transaction.nonce) + 1n) } });
    await assert.rejects(verifyExecutor({ trust, request: r, hash: h, clients: chain.clients }), /wrong nonce/);
  });
  await at(base, async () => {                                                         // another sender (anvil dev account 0)
    const r = await prepareExecutorRequest(executorArgs());
    const h = await walletSend(chain, { from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", data: r.transaction.data, gas: r.transaction.gas });
    await assert.rejects(verifyExecutor({ trust, request: r, hash: h, clients: chain.clients }), /wrong sender/);
  });
});

test("never a second executor for the reserve; an executor with the wrong immutables is never bound", T, async () => {
  await fromExecutor();                                                                       // the executor exists but its journal was lost
  await assert.rejects(prepareExecutorRequest(executorArgs()), /already exists at/);
  await at(base, async () => {
    // a second reserve, and an executor created for it at step 2's nonce, posing as step 2
    const other = await reserveStep(chain, { trust, artifacts });
    const ho = await send(other.transaction);
    const otherReserve = (await verifyReserve({ request: other, hash: ho, clients: chain.clients })).address;
    const r = await prepareExecutorRequest(executorArgs());
    const wrong = encodeDeployData({ abi: artifacts.EnclaveLeaseExecutor.abi, bytecode: artifacts.EnclaveLeaseExecutor.bytecode, args: [otherReserve] });
    const h = await send({ ...r.transaction, data: wrong });
    await assert.rejects(verifyExecutor({ trust, request: r, hash: h, clients: chain.clients }), /wrong creation code/);
    await assert.rejects(prepareBindRequest({ ...executorArgs(), executorRequest: r, executorHash: h }), /wrong creation code/);
    // a forged request claiming that code is for our reserve still fails on the exact runtime
    await assert.rejects(verifyExecutor({ trust, request: { ...r, transaction: { ...r.transaction, data: wrong } }, hash: h, clients: chain.clients }), /not the expected runtime/);
  });
});

test("an already-bound reserve, crossed-stage hashes and a rolled-back receipt are refused", T, async () => {
  {
    const E = await fromExecutor();
    await asAdmin(chain, reserve, RESERVE_ABI, "bindExecutor", [E.executor]);                    // bound out of band
    await assert.rejects(prepareBindRequest({ ...executorArgs(), executorRequest: E.r, executorHash: E.h }), /already bound/);
  }
  {
    const { r: req2, h: h2 } = await fromExecutor();
    const req3 = await prepareBindRequest({ ...executorArgs(), executorRequest: req2, executorHash: h2 });
    await assert.rejects(prepareBindRequest({ ...executorArgs(), executorRequest: req2, executorHash: h1 }), /reserve's creation hash|not a contract creation|wrong/);
    await assert.rejects(verifyBinding({ trust, request: req3, hash: h2, clients: chain.clients }), /executor's creation hash/);
    await assert.rejects(verifyBinding({ trust, request: req3, hash: h1, clients: chain.clients }), /reserve's creation hash/);
    const before3 = await chain.rpc("evm_snapshot");
    const h3 = await send(req3.transaction);
    await assert.rejects(verifyExecutor({ trust, request: req2, hash: h3, clients: chain.clients }), /not a contract creation/);
    await chain.rpc("evm_revert", [before3]); await chain.rpc("anvil_mine", ["0x5"]);           // the binding block is gone
    await assert.rejects(verifyBinding({ trust, request: req3, hash: h3, clients: chain.clients }));
  }
});

test("wrong chain, a repeated host and a disagreeing provider are refused", T, async () => {
  const other = await startChain({ chainId: 1 });
  const twin = await startChain({ chainId: 8453 });
  try {
    await at(base, async () => {
      await assert.rejects(prepareExecutorRequest({ ...executorArgs(), clients: [chain.clients[0], other.clients[1]] }));
      await assert.rejects(prepareExecutorRequest({ ...executorArgs(), clients: [chain.clients[0], chain.client(chain.url)] }), /duplicate RPC host/);
      await assert.rejects(prepareExecutorRequest({ ...executorArgs(), clients: [chain.clients[0], twin.clients[1]] }));
    });
  } finally { other.stop(); twin.stop(); }
});

test("stage servers: journal before the wallet, crossed-stage hash refused before it is recorded, 4001 only, restart and duplicate stage refused", T, async () => {
  await at(base, async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "j-"));
    const reserveJ = { read: () => ({ status: "ready" }), write: () => { throw Error("read-only"); } };
    const journals = { reserve: reserveJ, executor: fileJournal(path.join(dir, "executor.json")), bind: fileJournal(path.join(dir, "bind.json")) };
    const open = async (stage, j = journals) => { const app = stageApp({ stage, ...ctx(), journals: j }); opened.add(app); const origin = await app.listen(); const token = (await (await fetch(origin + "/request")).json()).token;
      const post = (u, b = {}) => fetch(origin + u, { method: "POST", headers: { Origin: origin, "X-Signing-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(b) });
      return { app, post }; };
    let s = await open("executor");
    assert.equal((await s.post("/prepare")).status, 400, "the reserve is not confirmed in its journal");
    assert.equal(s.app.state.status, "ready"); await s.app.close();
    journals.reserve = { read: () => ({ status: "confirmed", request: req1, hash: h1 }), write: reserveJ.write };
    s = await open("executor");
    const prep = await s.post("/prepare"); assert.equal(prep.status, 200);
    const { transaction } = await prep.json();
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "executor.json"), "utf8")).status, "awaiting-wallet", "journaled before the wallet saw it");
    const crossed = await s.post("/result", { hash: h1 });
    assert.equal(crossed.status, 400); assert.match((await crossed.json()).error, /another setup stage/);
    assert.equal(s.app.state.status, "awaiting-wallet"); assert.equal(s.app.state.hash, undefined, "nothing recorded");
    assert.equal((await s.post("/rejected", { code: -32603 })).status, 409);
    const h = await send(transaction);
    const done = await s.post("/result", { hash: h }); assert.equal(done.status, 200, await done.clone().text());
    assert.equal(s.app.state.status, "confirmed"); await s.app.close();
    s = await open("executor");                                                                  // restart
    assert.equal(s.app.state.status, "confirmed"); assert.equal((await s.post("/prepare")).status, 409); await s.app.close();
    // stage 3 on its own journal: explicit 4001 resets an unsubmitted attempt; then the real one
    let b = await open("bind");
    assert.equal((await b.post("/prepare")).status, 200);
    assert.equal((await b.post("/rejected", { code: 4001 })).status, 200); assert.equal(b.app.state.status, "ready");
    const again = await (await b.post("/prepare")).json();
    assert.equal((await b.post("/result", { hash: h })).status, 400, "the executor's hash is refused by the binding stage");
    const hb = await send(again.transaction);
    assert.equal((await b.post("/result", { hash: hb })).status, 200); assert.equal(b.app.state.verification.setupVerified, true); await b.app.close();
    // the executor stage never runs again once binding started, even with a fresh executor journal
    const j2 = { ...journals, executor: fileJournal(path.join(dir, "executor-2.json")) };
    s = await open("executor", j2);
    const dup = await s.post("/prepare"); assert.equal(dup.status, 400); assert.match((await dup.json()).error, /binding stage has already started/); await s.app.close();
  });
});

test("an unverifiable submitted hash stays submitted across restarts: no reset, no resend", T, async () => {
  await at(base, async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "u-"));
    const journals = { reserve: { read: () => ({ status: "confirmed", request: req1, hash: h1 }) }, executor: fileJournal(path.join(dir, "e.json")), bind: fileJournal(path.join(dir, "b.json")) };
    const open = async () => { const app = stageApp({ stage: "executor", ...ctx(), journals }); opened.add(app); const origin = await app.listen(); const token = (await (await fetch(origin + "/request")).json()).token;
      return { app, post: (u, b = {}) => fetch(origin + u, { method: "POST", headers: { Origin: origin, "X-Signing-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(b) }) }; };
    let s = await open();
    assert.equal((await s.post("/prepare")).status, 200);
    const unknown = "0x" + "77".repeat(32);                                                     // a hash the wallet returned that never appears
    assert.equal((await s.post("/result", { hash: unknown })).status, 400);
    assert.equal(s.app.state.status, "submitted"); await s.app.close();
    s = await open();
    assert.equal(s.app.state.status, "submitted"); assert.equal(s.app.state.hash, unknown);
    assert.equal((await s.post("/prepare")).status, 409); assert.equal((await s.post("/rejected", { code: 4001 })).status, 409);
    assert.equal((await s.post("/result", { hash: "0x" + "78".repeat(32) })).status, 409); await s.app.close();
  });
});
