// Stages 2 and 3 of the additive lease-gas setup, read-only: they prepare exact UNSIGNED requests and verify what a
// wallet later returned. They never sign, broadcast, fund or bind anything themselves.
//   stage 2: create EnclaveLeaseExecutor(reserve) against the ACTUAL reserve, verified afresh on two providers with
//            root's verifyReserve (receipt two blocks deep and canonical, exact runtime, owner, ledger, registry,
//            oracle, limits, executor still unbound). A predicted address or a saved "verified" JSON is never input.
//   stage 3: reserve.bindExecutor(executor), once, after both the reserve and the executor are verified afresh: the
//            executor's runtime must be the compiled runtime with its immutables (reserve, ledger, its own address)
//            filled in, byte for byte; a code hash alone is not accepted.
// Each preparation re-reads, at one anchor block agreed by two providers (head - 2): chain id, the admin's nonce at the
// anchor and its PENDING nonce on both providers (all equal), its balance, the address book's owner (the admin), the
// original ledger and registry code, and the reserve's state; then simulates the exact call on both providers at that
// block (creation: eth_call + eth_estimateGas + state-overridden getter calls; binding: eth_simulateV1, the method root's
// preflight used) and checks every returned getter there.
import assert from "node:assert/strict";
import { encodeDeployData, encodeFunctionData, decodeEventLog, getContractAddress, keccak256, encodePacked,
  parseAbi, serializeTransaction, toHex } from "../enclave/node_modules/viem/_esm/index.js";
import { verifyReserve } from "./verify-reserve.mjs";
import { executorRuntime } from "./artifacts.mjs";

const ZERO = "0x0000000000000000000000000000000000000000", ZERO32 = "0x" + "0".repeat(64);
const lc = (a) => String(a).toLowerCase();
const eq = (a, b, label) => assert.equal(lc(a), lc(b), label);
const hex = (n) => "0x" + BigInt(n).toString(16);
const max = (xs) => xs.reduce((m, x) => (x > m ? x : m), 0n);
const norm = (o) => JSON.parse(JSON.stringify(o, (_k, v) => typeof v === "bigint" ? v.toString() : typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? v.toLowerCase() : v));
export const RESERVE_ABI = parseAbi(["function owner() view returns(address)", "function pendingOwner() view returns(address)", "function ledger() view returns(address)",
  "function registry() view returns(address)", "function l1Oracle() view returns(address)", "function executor() view returns(address)",
  "function delegationCodeHash() view returns(bytes32)", "function paused() view returns(bool)", "function bindExecutor(address)",
  "event ExecutorBound(address executor, bytes32 delegationCodeHash)"]);
export const EXECUTOR_ABI = parseAbi(["function reserve() view returns(address)", "function ledger() view returns(address)",
  "function CANONICAL_LENGTH() view returns(uint256)", "function LEASE_TYPEHASH() view returns(bytes32)"]);
const BOOK_ABI = parseAbi(["function owner() view returns(address)"]);
const ORACLE_ABI = parseAbi(["function getL1Fee(bytes) view returns(uint256)"]);
const CANONICAL_LENGTH = 4n + 7n * 32n + 32n + 32n + 96n;
const LEASE_TYPEHASH = keccak256(new TextEncoder().encode("Lease(address reserve,bytes32 id,uint8 kind,bytes32 enclaveId,uint64 nonce,uint64 deadline,address payee,uint256 maxChargeWei)"));
export const delegationCodeHash = (executor) => keccak256(encodePacked(["bytes3", "address"], ["0xef0100", executor]));

/** Two different provider objects on two different hosts (root's rule). */
export function pair(clients) {
  assert.equal(clients.length, 2, "requires two independently operated providers");
  assert.notEqual(clients[0], clients[1], "duplicate client");
  assert.equal(new Set(clients.map((c) => new URL(c.transport.url).hostname)).size, 2, "duplicate RPC host");
  return clients;
}
/** The newest block both providers have, minus the confirmation depth, with the same hash on both. */
async function anchorOf(clients, trust) {
  const heads = await Promise.all(clients.map((c) => c.getBlockNumber({ cacheTime: 0 })));
  const blockNumber = heads.reduce((a, b) => (a < b ? a : b)) - trust.confirmations;
  const blocks = await Promise.all(clients.map((c) => c.getBlock({ blockNumber })));
  eq(blocks[0].hash, blocks[1].hash, "providers disagree on the anchor block");
  return { blockNumber, blockHash: blocks[0].hash, baseFee: BigInt(blocks[0].baseFeePerGas ?? 0n) };
}
const call = (c, address, abi, functionName, blockNumber, args = []) => c.readContract({ address, abi, functionName, args, blockNumber });

/** Admin, authority and reserve state on one provider at the anchor. Throws on anything not exactly as expected. */
async function readState(c, trust, blockNumber, reserve) {
  const admin = trust.admin;
  const [chainId, balance, nonce, pending, bookOwner, ledgerCode, registryCode, reserveCode] = await Promise.all([
    c.getChainId(), c.getBalance({ address: admin, blockNumber }), c.getTransactionCount({ address: admin, blockNumber }),
    c.getTransactionCount({ address: admin, blockTag: "pending" }), call(c, trust.book, BOOK_ABI, "owner", blockNumber),
    c.getCode({ address: trust.ledger, blockNumber }), c.getCode({ address: trust.registry, blockNumber }), c.getCode({ address: reserve.address, blockNumber })]);
  assert.equal(Number(chainId), trust.chainId, "wrong chain");
  eq(bookOwner, admin, "the address book's owner is no longer the admin");
  assert.equal(ledgerCode ? keccak256(ledgerCode) : null, trust.codeHashes.ledger, "the original ledger code changed");
  assert.equal(registryCode ? keccak256(registryCode) : null, trust.codeHashes.registry, "the original registry code changed");
  assert.equal(reserveCode ? keccak256(reserveCode) : null, reserve.runtimeHash, "the reserve's runtime changed");
  const r = Object.fromEntries(await Promise.all(["owner", "pendingOwner", "ledger", "registry", "l1Oracle", "executor", "delegationCodeHash", "paused"]
    .map(async (f) => [f, await call(c, reserve.address, RESERVE_ABI, f, blockNumber)])));
  eq(r.owner, admin, "the reserve's owner is not the admin"); eq(r.pendingOwner, ZERO, "a reserve ownership transfer is pending");
  eq(r.ledger, trust.ledger, "the reserve's ledger is not the original ledger"); eq(r.registry, trust.registry, "the reserve's registry is not the original registry");
  eq(r.l1Oracle, trust.oracle, "the reserve's oracle changed"); assert.equal(r.paused, false, "the reserve is paused");
  return { chainId: Number(chainId), balance: BigInt(balance), nonce: Number(nonce), pending: Number(pending), reserve: r };
}

/** One eth_simulateV1 bundle at the anchor; every call must succeed. -> the calls' results. */
async function simulate(c, blockNumber, calls) {
  const got = (await c.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ calls }], validation: false, traceTransfers: false }, toHex(blockNumber)] }))?.[0]?.calls;
  assert.ok(Array.isArray(got) && got.length === calls.length, "simulation returned an unexpected result");
  got.forEach((x, i) => assert.equal(x.status, "0x1", `simulated call ${i} failed`));
  return got;
}
const word = (v) => lc(v);
const addrWord = (a) => "0x" + lc(a).slice(2).padStart(64, "0");

/** Fees, gas limit and the L1 estimate, refreshed on both providers; checked against the caps and the admin balance. */
async function fees(clients, trust, { anchor, gasUsed, cap, tx, balance }) {
  const tips = await Promise.all(clients.map((c) => c.estimateMaxPriorityFeePerGas()));
  const tip = max(tips.map(BigInt)), maxFeePerGas = anchor.baseFee * 2n + tip;
  const gas = (gasUsed * 120n + 99n) / 100n;
  assert.ok(gas > 0n && gas <= cap, "gas exceeds the reviewed cap");
  assert.ok(maxFeePerGas > 0n && maxFeePerGas <= trust.caps.maxFeePerGas && tip <= maxFeePerGas, "fee exceeds the reviewed cap");
  const raw = serializeTransaction({ type: "eip1559", chainId: trust.chainId, nonce: tx.nonce, ...(tx.to ? { to: tx.to } : {}), data: tx.data, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas: tip });
  const l1 = max((await Promise.all(clients.map((c) => call(c, trust.oracle, ORACLE_ABI, "getL1Fee", anchor.blockNumber, [raw])))).map(BigInt));
  assert.ok(balance >= gas * maxFeePerGas + l1, "the admin's balance does not cover this transaction");
  return { gas, maxFeePerGas, tip, l1 };
}
/** Fresh state on both providers at the anchor, identical, with the pending nonce agreed and equal to the anchor's. */
async function freshState(clients, trust, anchor, reserve) {
  const s = await Promise.all(clients.map((c) => readState(c, trust, anchor.blockNumber, reserve)));
  assert.deepEqual(norm({ ...s[0], pending: 0 }), norm({ ...s[1], pending: 0 }), "providers disagree on the admin or reserve state");
  for (const x of s) assert.equal(x.pending, x.nonce, "a transaction from the admin is pending or was mined after the anchor; wait and prepare again");
  return s[0];
}
const ageCheck = (now, trust) => ({ preparedAt: new Date(now).toISOString(), expiresAt: new Date(now + trust.maxAgeMs).toISOString() });

// ---- stage 2: executor creation ----------------------------------------------------------------------------------------

/**
 * prepareExecutorRequest({ trust, artifacts, reserveRequest, reserveHash, clients, now }) -> the exact unsigned
 * creation request. reserveRequest + reserveHash are what root's reserve handoff journaled (its request and the hash
 * the wallet returned); the reserve they name is verified afresh here, never taken from a saved result.
 */
export async function prepareExecutorRequest({ trust, artifacts, reserveRequest, reserveHash, clients, now = Date.now() }) {
  pair(clients);
  eq(reserveRequest.transaction.from, trust.admin, "the reserve was not created by the admin");
  const verified = await verifyReserve({ request: reserveRequest, hash: reserveHash, clients });   // root's own verifier
  eq(verified.owner, trust.admin, "reserve owner"); eq(verified.ledger, trust.ledger, "reserve ledger"); eq(verified.registry, trust.registry, "reserve registry");
  eq(verified.oracle, trust.oracle, "reserve oracle"); eq(verified.executor, ZERO, "the reserve is already bound");
  const reserve = { address: verified.address, transactionHash: verified.transactionHash, runtimeHash: verified.runtimeHash, creationBlock: verified.creationBlock,
    creationNonce: Number(BigInt(reserveRequest.transaction.nonce)) };
  const anchor = await anchorOf(clients, trust);
  const st = await freshState(clients, trust, anchor, reserve);
  eq(st.reserve.executor, ZERO, "the reserve is already bound"); eq(st.reserve.delegationCodeHash, ZERO32, "the reserve already has a delegation code hash");
  // never a second executor for this reserve: inspect every admin creation since the reserve's
  const art = artifacts.EnclaveLeaseExecutor;
  assert.ok(st.nonce > reserve.creationNonce, "the admin's nonce is not past the reserve's creation");
  assert.ok(st.nonce - reserve.creationNonce - 1 <= trust.maxNonceScan, "too many admin transactions since the reserve's creation to inspect; review by hand");
  for (let n = reserve.creationNonce + 1; n < st.nonce; n++) {
    const at = getContractAddress({ from: trust.admin, nonce: BigInt(n) });
    const want = executorRuntime(art, { reserve: reserve.address, ledger: trust.ledger, self: at });
    const codes = await Promise.all(clients.map((c) => c.getCode({ address: at, blockNumber: anchor.blockNumber })));
    if (codes.some((x) => x && lc(x) === lc(want))) throw new Error(`an executor for this reserve already exists at ${at} (admin nonce ${n}); verify and bind that one, do not deploy another`);
  }
  const predicted = getContractAddress({ from: trust.admin, nonce: BigInt(st.nonce) });
  const runtime = executorRuntime(art, { reserve: reserve.address, ledger: trust.ledger, self: predicted });
  const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: [reserve.address] });
  // Creation is simulated with eth_call at the anchor (the constructor really runs: it reads reserve.ledger() and its own
  // address, so the returned runtime carries the immutables it computed) plus eth_estimateGas at the anchor; each getter
  // then runs on that returned runtime through a state override at the predicted address. (eth_simulateV1, used for
  // the binding, cannot build a creation call on every node.)
  const sims = await Promise.all(clients.map(async (c) => {
    const created = (await c.call({ account: trust.admin, data, gas: trust.caps.executorGas, blockNumber: anchor.blockNumber })).data;
    const gas = await c.estimateGas({ account: trust.admin, data, value: 0n, blockNumber: anchor.blockNumber });
    const get = async (f) => (await c.call({ to: predicted, data: encodeFunctionData({ abi: EXECUTOR_ABI, functionName: f }), blockNumber: anchor.blockNumber,
      stateOverride: [{ address: predicted, code: created }] })).data;
    const bound = await call(c, reserve.address, RESERVE_ABI, "executor", anchor.blockNumber);
    return { created, gas: BigInt(gas), getters: await Promise.all(["reserve", "ledger", "CANONICAL_LENGTH", "LEASE_TYPEHASH"].map(get)), bound };
  }));
  for (const s of sims) {
    assert.equal(lc(s.created), lc(runtime), "the simulated executor runtime is not the compiled runtime with these immutables");
    assert.equal(word(s.getters[0]), addrWord(reserve.address), "simulated executor.reserve()");
    assert.equal(word(s.getters[1]), addrWord(trust.ledger), "simulated executor.ledger()");
    assert.equal(BigInt(s.getters[2]), CANONICAL_LENGTH, "simulated CANONICAL_LENGTH");
    assert.equal(word(s.getters[3]), lc(LEASE_TYPEHASH), "simulated LEASE_TYPEHASH");
    eq(s.bound, ZERO, "the reserve would not be unbound");
  }
  const gasUsed = max(sims.map((s) => s.gas));
  const f = await fees(clients, trust, { anchor, gasUsed, cap: trust.caps.executorGas, tx: { nonce: st.nonce, data }, balance: st.balance });
  return { format: "enclave-lease-executor-creation/v1", stage: "executor", status: "prepared; wallet approval required; nothing sent", ...ageCheck(now, trust),
    purpose: "Create the lease executor for the verified reserve; zero ETH",
    transaction: { from: trust.admin, chainId: hex(trust.chainId), type: "0x2", nonce: hex(st.nonce), data, value: "0x0", gas: hex(f.gas), maxFeePerGas: hex(f.maxFeePerGas), maxPriorityFeePerGas: hex(f.tip) },
    reserve, ledger: trust.ledger, expectedRuntimeHash: keccak256(runtime), expectedRuntime: runtime,
    predictedAddress: predicted, predictedAddressWarning: "NOT a funding destination and not evidence: binding is prepared only after the receipt and runtime are verified",
    anchor: { blockNumber: String(anchor.blockNumber), blockHash: anchor.blockHash }, provenance: art.provenance,
    simulatedGasUsed: String(gasUsed), estimatedFeeLimitWei: String(f.gas * f.maxFeePerGas + f.l1) };
}

/** A returned creation transaction and its receipt and runtime are exactly the request's. */
export function checkExecutorLanding(request, { transaction: tx, receipt, code }) {
  assert.equal(request.stage, "executor", "not an executor-creation request");
  const w = request.transaction;
  eq(tx.from, w.from, "wrong sender"); assert.equal(tx.to ?? null, null, "not a contract creation");
  assert.equal(Number(tx.chainId), Number(BigInt(w.chainId)), "wrong chain"); assert.equal(tx.type, "eip1559", "not an EIP-1559 transaction");
  assert.equal(Number(tx.nonce), Number(BigInt(w.nonce)), "wrong nonce"); eq(tx.input, w.data, "wrong creation code"); assert.equal(BigInt(tx.value), 0n, "value sent");
  assert.equal(BigInt(tx.gas), BigInt(w.gas), "gas changed");
  assert.ok(BigInt(tx.maxFeePerGas) <= BigInt(w.maxFeePerGas), "wallet increased fee cap");
  assert.ok(BigInt(tx.maxPriorityFeePerGas) <= BigInt(w.maxPriorityFeePerGas), "wallet increased priority cap");
  assert.equal(receipt.status, "success", "creation reverted"); eq(receipt.transactionHash, tx.hash, "receipt hash differs");
  eq(receipt.contractAddress, getContractAddress({ from: w.from, nonce: BigInt(w.nonce) }), "wrong deployed address");
  eq(receipt.contractAddress, request.predictedAddress, "wrong deployed address");
  assert.equal(lc(code), lc(request.expectedRuntime), "the deployed runtime is not the expected runtime");
  return receipt.contractAddress;
}

/** A receipt two blocks deep and canonical on both providers, and the landed transaction/runtime/getters at one anchor. */
async function landed(clients, trust, hash, check) {
  pair(clients);
  assert.match(hash, /^0x[0-9a-fA-F]{64}$/, "invalid transaction hash");
  const anchor = await anchorOf(clients, trust);
  const results = await Promise.all(clients.map(async (c) => {
    assert.equal(Number(await c.getChainId()), trust.chainId, "wrong chain");
    const [tx, receipt] = await Promise.all([c.getTransaction({ hash }), c.getTransactionReceipt({ hash })]);
    eq(tx.hash, hash, "provider returned another transaction");
    assert.ok(BigInt(receipt.blockNumber) <= anchor.blockNumber, "the transaction lacks two later blocks");
    eq((await c.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash, "the receipt is not canonical");
    const out = await check(c, tx, receipt, anchor.blockNumber);
    eq((await c.getBlock({ blockNumber: anchor.blockNumber })).hash, anchor.blockHash, "the anchor block changed during verification");
    return { ...out, transactionHash: lc(hash), minedBlock: String(receipt.blockNumber), minedBlockHash: receipt.blockHash, blockNumber: String(anchor.blockNumber), blockHash: anchor.blockHash };
  }));
  assert.deepEqual(norm(results[0]), norm(results[1]), "providers disagree on the confirmed transaction");
  return results[0];
}

/** verifyExecutor({ trust, request, hash, clients }) -> the verified executor (not yet bound), or throws. */
export async function verifyExecutor({ trust, request, hash, clients }) {
  const r = await landed(clients, trust, hash, async (c, tx, receipt, blockNumber) => {
    assert.ok((tx.to ?? null) === null && receipt.contractAddress, "not a contract creation");
    const code = await c.getCode({ address: receipt.contractAddress, blockNumber });
    const address = checkExecutorLanding(request, { transaction: tx, receipt, code });
    const [res, led, len, th] = await Promise.all(["reserve", "ledger", "CANONICAL_LENGTH", "LEASE_TYPEHASH"].map((f) => call(c, address, EXECUTOR_ABI, f, blockNumber)));
    eq(res, request.reserve.address, "the executor is for another reserve"); eq(led, trust.ledger, "the executor's ledger is not the original ledger");
    assert.equal(BigInt(len), CANONICAL_LENGTH); eq(th, LEASE_TYPEHASH, "LEASE_TYPEHASH");
    const reserveCode = await c.getCode({ address: request.reserve.address, blockNumber });
    assert.equal(reserveCode ? keccak256(reserveCode) : null, request.reserve.runtimeHash, "the reserve's runtime changed");
    const bound = await call(c, request.reserve.address, RESERVE_ABI, "executor", blockNumber);
    assert.ok(lc(bound) === lc(ZERO) || lc(bound) === lc(address), `the reserve is bound to another executor (${bound})`);
    return { address, runtimeHash: keccak256(code), reserve: request.reserve.address, reserveBoundTo: lc(bound) };
  });
  return { status: r.reserveBoundTo === lc(ZERO) ? "executor creation verified; not yet bound" : "executor creation verified; already bound to this reserve", verifiedAt: new Date().toISOString(),
    providers: 2, ...r, fundingReady: false };
}

// ---- stage 3: one-time binding -----------------------------------------------------------------------------------------

/**
 * prepareBindRequest({ trust, artifacts, reserveRequest, reserveHash, executorRequest, executorHash, clients, now }):
 * the exact unsigned reserve.bindExecutor(executor) request, after the reserve AND the executor are verified afresh.
 */
export async function prepareBindRequest({ trust, artifacts, reserveRequest, reserveHash, executorRequest, executorHash, clients, now = Date.now() }) {
  pair(clients);
  assert.equal(executorRequest.stage, "executor", "the executor request is not a stage-2 request");
  eq(executorRequest.reserve.transactionHash, reserveHash, "the executor request was prepared for another reserve creation");
  assert.notEqual(lc(executorHash), lc(reserveHash), "the executor hash is the reserve's creation hash");
  const verified = await verifyReserve({ request: reserveRequest, hash: reserveHash, clients });   // requires the reserve still unbound
  eq(executorRequest.reserve.address, verified.address, "the executor request was prepared for another reserve");
  const reserve = { address: verified.address, transactionHash: verified.transactionHash, runtimeHash: verified.runtimeHash };
  const ex = await verifyExecutor({ trust, request: executorRequest, hash: executorHash, clients });
  assert.equal(ex.reserveBoundTo, lc(ZERO), "the reserve is already bound");
  const anchor = await anchorOf(clients, trust);
  const st = await freshState(clients, trust, anchor, reserve);
  eq(st.reserve.executor, ZERO, "the reserve is already bound"); eq(st.reserve.delegationCodeHash, ZERO32, "the reserve already has a delegation code hash");
  const runtime = executorRuntime(artifacts.EnclaveLeaseExecutor, { reserve: reserve.address, ledger: trust.ledger, self: ex.address });
  const codes = await Promise.all(clients.map((c) => c.getCode({ address: ex.address, blockNumber: anchor.blockNumber })));
  for (const code of codes) assert.equal(lc(code), lc(runtime), "the executor's runtime is not the exact compiled runtime for this reserve");
  const data = encodeFunctionData({ abi: RESERVE_ABI, functionName: "bindExecutor", args: [ex.address] });
  const dch = delegationCodeHash(ex.address);
  const calls = [{ from: trust.admin, to: reserve.address, data, gas: hex(trust.caps.bindGas), value: "0x0" },
    ...["executor", "delegationCodeHash", "owner"].map((f) => ({ from: trust.admin, to: reserve.address, data: encodeFunctionData({ abi: RESERVE_ABI, functionName: f }), gas: "0x186a0", value: "0x0" }))];
  const sims = await Promise.all(clients.map((c) => simulate(c, anchor.blockNumber, calls)));
  for (const got of sims) {
    assert.equal(word(got[1].returnData), addrWord(ex.address), "simulated binding does not bind this executor");
    assert.equal(word(got[2].returnData), lc(dch), "simulated delegation code hash");
    assert.equal(word(got[3].returnData), addrWord(trust.admin), "the admin would not remain the reserve's owner");
  }
  const gasUsed = max(sims.map((g) => BigInt(g[0].gasUsed)));
  const f = await fees(clients, trust, { anchor, gasUsed, cap: trust.caps.bindGas, tx: { nonce: st.nonce, to: reserve.address, data }, balance: st.balance });
  return { format: "enclave-lease-executor-binding/v1", stage: "bind", status: "prepared; wallet approval required; nothing sent", ...ageCheck(now, trust),
    purpose: "Bind the verified executor to the verified reserve, once; zero ETH",
    transaction: { from: trust.admin, to: reserve.address, chainId: hex(trust.chainId), type: "0x2", nonce: hex(st.nonce), data, value: "0x0", gas: hex(f.gas), maxFeePerGas: hex(f.maxFeePerGas), maxPriorityFeePerGas: hex(f.tip) },
    reserve, executor: { address: ex.address, transactionHash: lc(executorHash), runtimeHash: keccak256(runtime) }, expectedDelegationCodeHash: dch,
    anchor: { blockNumber: String(anchor.blockNumber), blockHash: anchor.blockHash }, simulatedGasUsed: String(gasUsed), estimatedFeeLimitWei: String(f.gas * f.maxFeePerGas + f.l1) };
}

/** The returned binding transaction and receipt are exactly the request's, with exactly one ExecutorBound from the reserve. */
export function checkBindLanding(request, { transaction: tx, receipt }) {
  assert.equal(request.stage, "bind", "not a binding request");
  const w = request.transaction;
  eq(tx.from, w.from, "wrong sender"); eq(tx.to, w.to, "wrong destination"); assert.equal(Number(tx.chainId), Number(BigInt(w.chainId)), "wrong chain");
  assert.equal(tx.type, "eip1559", "not an EIP-1559 transaction"); assert.equal(Number(tx.nonce), Number(BigInt(w.nonce)), "wrong nonce");
  eq(tx.input, w.data, "wrong calldata"); assert.equal(BigInt(tx.value), 0n, "value sent"); assert.equal(BigInt(tx.gas), BigInt(w.gas), "gas changed");
  assert.ok(BigInt(tx.maxFeePerGas) <= BigInt(w.maxFeePerGas), "wallet increased fee cap");
  assert.ok(BigInt(tx.maxPriorityFeePerGas) <= BigInt(w.maxPriorityFeePerGas), "wallet increased priority cap");
  assert.equal(receipt.status, "success", "binding reverted"); eq(receipt.transactionHash, tx.hash, "receipt hash differs");
  const events = receipt.logs.filter((l) => lc(l.address) === lc(w.to)).map((l) => { try { return decodeEventLog({ abi: RESERVE_ABI, data: l.data, topics: l.topics }); } catch { return null; } })
    .filter((e) => e?.eventName === "ExecutorBound");
  assert.equal(events.length, 1, "expected exactly one ExecutorBound event");
  eq(events[0].args.executor, request.executor.address, "bound another executor"); eq(events[0].args.delegationCodeHash, request.expectedDelegationCodeHash, "wrong delegation code hash");
}

/** verifyBinding({ trust, request, hash, clients }) -> all three setup steps verified, or throws. */
export async function verifyBinding({ trust, request, hash, clients }) {
  assert.notEqual(lc(hash), lc(request.reserve.transactionHash), "that is the reserve's creation hash");
  assert.notEqual(lc(hash), lc(request.executor.transactionHash), "that is the executor's creation hash");
  const r = await landed(clients, trust, hash, async (c, tx, receipt, blockNumber) => {
    checkBindLanding(request, { transaction: tx, receipt });
    const reserve = request.reserve.address, executor = request.executor.address;
    const s = Object.fromEntries(await Promise.all(["owner", "pendingOwner", "ledger", "registry", "l1Oracle", "executor", "delegationCodeHash", "paused"]
      .map(async (f) => [f, await call(c, reserve, RESERVE_ABI, f, blockNumber)])));
    eq(s.executor, executor, "the reserve is not bound to the verified executor"); eq(s.delegationCodeHash, request.expectedDelegationCodeHash, "delegation code hash");
    eq(s.owner, trust.admin, "the reserve's owner changed"); eq(s.pendingOwner, ZERO, "a reserve ownership transfer is pending");
    eq(s.ledger, trust.ledger, "reserve ledger"); eq(s.registry, trust.registry, "reserve registry"); eq(s.l1Oracle, trust.oracle, "reserve oracle");
    const [rc, ec, bookOwner] = await Promise.all([c.getCode({ address: reserve, blockNumber }), c.getCode({ address: executor, blockNumber }), call(c, trust.book, BOOK_ABI, "owner", blockNumber)]);
    assert.equal(rc ? keccak256(rc) : null, request.reserve.runtimeHash, "the reserve's runtime changed");
    assert.equal(ec ? keccak256(ec) : null, request.executor.runtimeHash, "the executor's runtime changed");
    eq(await call(c, executor, EXECUTOR_ABI, "reserve", blockNumber), reserve, "the executor's reserve changed");
    eq(bookOwner, trust.admin, "the address book's owner is no longer the admin");
    return { reserve: lc(reserve), executor: lc(executor), delegationCodeHash: lc(s.delegationCodeHash), owner: lc(s.owner), paused: s.paused };
  });
  return { status: "executor bound; all three setup steps verified", verifiedAt: new Date().toISOString(), providers: 2, ...r, setupVerified: true,
    fundingDestination: r.reserve, fundingNote: "Deposits remain per-app reviewed requests (deposit / depositAndFundCompute with the app's id); nothing is funded by this step." };
}
