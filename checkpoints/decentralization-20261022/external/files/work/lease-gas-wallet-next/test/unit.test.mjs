// Pure tests (no chain): production pins vs root's read.mjs, artifact/source/closure tampering, the exact executor
// runtime, landing checks, and mocked bad-chain answers (reorged receipt, shallow receipt, disagreeing providers,
// wrong chain, another transaction, an anchor that moves during verification).
//   run: node --test --test-concurrency=1 test/unit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { encodeDeployData, encodeFunctionData, encodeEventTopics, encodeAbiParameters, getContractAddress, keccak256 } from "../../enclave/node_modules/viem/_esm/index.js";
import { PRODUCTION } from "../trust.mjs";
import { verifiedArtifacts, executorRuntime, DEFAULT_PATHS } from "../artifacts.mjs";
import { checkExecutorLanding, checkBindLanding, verifyExecutor, verifyBinding, delegationCodeHash, RESERVE_ABI } from "../stages.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const arts = verifiedArtifacts({ trust: PRODUCTION });
const ex = arts.EnclaveLeaseExecutor;

test("production pins are root's: read.mjs constants, calibration ledger/registry, accepted source hashes, providers", () => {
  const read = fs.readFileSync(path.join(HERE, "../base/preflight-read.mjs"), "utf8");
  const str = (re) => re.exec(read)[1].toLowerCase();
  assert.equal(PRODUCTION.admin.toLowerCase(), str(/const owner = "(0x[0-9a-fA-F]{40})"/));
  assert.equal(PRODUCTION.book.toLowerCase(), str(/const book = "(0x[0-9a-fA-F]{40})"/));
  assert.equal(PRODUCTION.oracle.toLowerCase(), str(/const oracle = "(0x[0-9a-fA-F]{40})"/));
  assert.equal(PRODUCTION.codeHashes.ledger, str(/ledger: "(0x[0-9a-f]{64})"/));
  assert.equal(PRODUCTION.codeHashes.registry, str(/registry: "(0x[0-9a-f]{64})"/));
  const cal = JSON.parse(fs.readFileSync("/home/steven/Documents/Codex/2026-10-18/wo/work/app-lease-gas/fixtures/base-fork-calibration-recalibrated.json", "utf8")).deployment;
  assert.equal(PRODUCTION.ledger.toLowerCase(), cal.ledger.toLowerCase()); assert.equal(PRODUCTION.registry.toLowerCase(), cal.registry.toLowerCase());
  for (const [n, h] of Object.entries(PRODUCTION.acceptedSources)) assert.equal(sha(fs.readFileSync(`${DEFAULT_PATHS.main}/${n}.sol`)), h);
  const urls = /const urls=\[([^\]]+)\]/.exec(fs.readFileSync(path.join(HERE, "../base/current/serve-reserve.mjs"), "utf8"))[1];   // root's current pair
  for (const u of PRODUCTION.rpcs) assert.ok(urls.includes(u), u);
});

test("the frozen artifacts verify; a changed source, copy, closure input or artifact is refused", () => {
  assert.deepEqual(Object.keys(arts).sort(), ["EnclaveLeaseExecutor", "EnclaveLeaseGasReserve"]);
  assert.deepEqual(ex.provenance.closure, ["src/EnclaveLeaseExecutor.sol"]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lease-art-"));
  try {
    const p = { main: path.join(tmp, "main"), copy: path.join(tmp, "copy"), forge: path.join(tmp, "forge"), preflight: DEFAULT_PATHS.preflight };
    const reset = () => {
      fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
      for (const d of [p.main, p.copy, path.join(p.forge, "src")]) fs.mkdirSync(d, { recursive: true });
      for (const n of ["EnclaveLeaseGasReserve", "EnclaveLeaseExecutor"]) {
        for (const d of [p.main, p.copy, path.join(p.forge, "src")]) fs.copyFileSync(`${DEFAULT_PATHS.main}/${n}.sol`, path.join(d, `${n}.sol`));
        fs.mkdirSync(path.join(p.forge, "out", `${n}.sol`), { recursive: true });
        fs.copyFileSync(`${DEFAULT_PATHS.forge}/out/${n}.sol/${n}.json`, path.join(p.forge, "out", `${n}.sol`, `${n}.json`));
      }
    };
    reset(); verifiedArtifacts({ trust: PRODUCTION, paths: p });
    const cases = [
      ["main source", () => fs.appendFileSync(path.join(p.main, "EnclaveLeaseExecutor.sol"), "\n"), /not the accepted source/],
      ["app copy", () => fs.appendFileSync(path.join(p.copy, "EnclaveLeaseGasReserve.sol"), "\n"), /missing or differs from the accepted main source/],
      ["closure input missing", () => fs.rmSync(path.join(p.forge, "src", "EnclaveLeaseExecutor.sol")), /differs from the accepted main source|missing/],
      ["artifact", () => { const f = path.join(p.forge, "out", "EnclaveLeaseExecutor.sol", "EnclaveLeaseExecutor.json"); const j = JSON.parse(fs.readFileSync(f)); j.deployedBytecode.object = j.deployedBytecode.object.slice(0, -2) + (j.deployedBytecode.object.endsWith("00") ? "01" : "00"); fs.writeFileSync(f, JSON.stringify(j)); }, /provenance/],
    ];
    for (const [name, change, pattern] of cases) { reset(); change(); assert.throws(() => verifiedArtifacts({ trust: PRODUCTION, paths: p }), pattern, name); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("the executor runtime is the compiled runtime with reserve, ledger and its own address filled in", () => {
  const a = { reserve: "0x" + "aa".repeat(20), ledger: PRODUCTION.ledger, self: "0x" + "cc".repeat(20) };
  const code = executorRuntime(ex, a);
  assert.equal(code.length, ex.deployedBytecode.length);
  const words = (x) => (code.match(new RegExp(x.slice(2).toLowerCase().padStart(64, "0"), "g")) || []).length;
  assert.equal(words(a.reserve), 3); assert.equal(words(a.ledger), 4); assert.equal(words(a.self), 2);
  assert.notEqual(code, executorRuntime(ex, { ...a, self: "0x" + "cd".repeat(20) }));
  assert.throws(() => executorRuntime({ ...ex, immutableReferences: {} }, a), /immutable layout/);
});

// ---- a synthetic stage-2 request and mocked providers ----
const reserve = "0x" + "5e".repeat(20), nonce = 1114n, admin = PRODUCTION.admin;
const predicted = getContractAddress({ from: admin, nonce });
const runtime = executorRuntime(ex, { reserve, ledger: PRODUCTION.ledger, self: predicted });
const data = encodeDeployData({ abi: ex.abi, bytecode: ex.bytecode, args: [reserve] });
const req2 = { stage: "executor", transaction: { from: admin, chainId: "0x2105", type: "0x2", nonce: "0x" + nonce.toString(16), data, value: "0x0", gas: "0x1e8480", maxFeePerGas: "0x5f5e100", maxPriorityFeePerGas: "0xf4240" },
  reserve: { address: reserve, transactionHash: "0x" + "01".repeat(32), runtimeHash: keccak256("0x6001") }, predictedAddress: predicted, expectedRuntime: runtime };
const hash = "0x" + "ab".repeat(32), blockHash = "0x" + "cd".repeat(32), anchorHash = "0x" + "ef".repeat(32);
const LEASE_TYPEHASH = keccak256(new TextEncoder().encode("Lease(address reserve,bytes32 id,uint8 kind,bytes32 enclaveId,uint64 nonce,uint64 deadline,address payee,uint256 maxChargeWei)"));
function peers(mutate = () => {}) {
  return ["a.example", "b.example"].map((host, i) => {
    const s = { chainId: 8453, head: 104n, anchorHash, code: runtime, reserveCode: "0x6001",
      tx: { hash, from: admin, to: null, chainId: 8453, type: "eip1559", nonce: Number(nonce), input: data, value: 0n, gas: BigInt(req2.transaction.gas), maxFeePerGas: BigInt(req2.transaction.maxFeePerGas), maxPriorityFeePerGas: BigInt(req2.transaction.maxPriorityFeePerGas) },
      receipt: { transactionHash: hash, status: "success", contractAddress: predicted, blockNumber: 100n, blockHash, logs: [] },
      getters: { reserve, ledger: PRODUCTION.ledger, CANONICAL_LENGTH: 388n, LEASE_TYPEHASH, executor: "0x0000000000000000000000000000000000000000" }, moves: false };
    mutate(s, i);
    let reads = 0;
    return { transport: { url: `https://${host}` }, getBlockNumber: async () => s.head, getChainId: async () => s.chainId,
      getBlock: async ({ blockNumber }) => ({ hash: blockNumber === 100n ? blockHash : (s.moves && reads++ > 0 ? "0x" + "99".repeat(32) : s.anchorHash), baseFeePerGas: 1n }),
      getTransaction: async () => s.tx, getTransactionReceipt: async () => s.receipt,
      getCode: async ({ address }) => (address.toLowerCase() === reserve ? s.reserveCode : s.code),
      readContract: async ({ functionName, blockNumber }) => { assert.equal(blockNumber, 102n, "everything is read at the anchor"); return s.getters[functionName]; } };
  });
}

test("a matching canonical, two-deep creation with the exact runtime and getters verifies on both providers", async () => {
  const v = await verifyExecutor({ trust: PRODUCTION, request: req2, hash, clients: peers() });
  assert.equal(v.address.toLowerCase(), predicted.toLowerCase()); assert.equal(v.fundingReady, false); assert.equal(v.status, "executor creation verified; not yet bound");
});
for (const [name, change, pattern] of [
  ["reorged receipt", (s) => { s.receipt.blockHash = "0x" + "12".repeat(32); }, /not canonical/],
  ["one block deep", (s) => { s.receipt.blockNumber = 103n; }, /two later blocks/],
  ["another transaction", (s) => { s.tx.hash = "0x" + "12".repeat(32); }, /another transaction/],
  ["wrong chain", (s) => { s.chainId = 1; }, /wrong chain/],
  ["wrong sender", (s) => { s.tx.from = "0x" + "11".repeat(20); }, /wrong sender/],
  ["wrong nonce", (s) => { s.tx.nonce = Number(nonce) + 1; }, /wrong nonce/],
  ["value", (s) => { s.tx.value = 1n; }, /value sent/],
  ["calldata", (s) => { s.tx.input = data.slice(0, -2) + "00"; }, /wrong creation code/],
  ["fee raised", (s) => { s.tx.maxFeePerGas += 1n; }, /increased fee cap/],
  ["priority raised", (s) => { s.tx.maxPriorityFeePerGas += 1n; }, /increased priority cap/],
  ["gas changed", (s) => { s.tx.gas += 1n; }, /gas changed/],
  ["legacy type", (s) => { s.tx.type = "legacy"; }, /EIP-1559/],
  ["not a creation", (s) => { s.tx.to = reserve; }, /not a contract creation/],
  ["reverted", (s) => { s.receipt.status = "reverted"; }, /creation reverted/],
  ["wrong immutable runtime", (s) => { s.code = executorRuntime(ex, { reserve: "0x" + "77".repeat(20), ledger: PRODUCTION.ledger, self: predicted }); }, /not the expected runtime/],
  ["executor of another reserve", (s) => { s.getters.reserve = "0x" + "77".repeat(20); }, /another reserve/],
  ["reserve bound elsewhere", (s) => { s.getters.executor = "0x" + "77".repeat(20); }, /bound to another executor/],
  ["reserve runtime changed", (s) => { s.reserveCode = "0x6002"; }, /reserve's runtime changed/],
  ["provider snapshot disagreement", (s) => { s.anchorHash = "0x" + "13".repeat(32); }, /disagree on the anchor/],
  ["anchor moves during verification", (s) => { s.moves = true; }, /anchor block changed|disagree/],
]) test(`verifyExecutor refuses when one provider shows: ${name}`, async () => {
  await assert.rejects(verifyExecutor({ trust: PRODUCTION, request: req2, hash, clients: peers((s, i) => { if (i === 1) change(s); }) }), pattern);
});
test("verifyExecutor refuses a repeated provider, a repeated host and a non-executor request", async () => {
  const [c] = peers();
  await assert.rejects(verifyExecutor({ trust: PRODUCTION, request: req2, hash, clients: [c, c] }), /duplicate client/);
  const [a, b] = peers(); b.transport.url = "https://a.example/other";
  await assert.rejects(verifyExecutor({ trust: PRODUCTION, request: req2, hash, clients: [a, b] }), /duplicate RPC host/);
  await assert.rejects(verifyExecutor({ trust: PRODUCTION, request: { ...req2, stage: "bind" }, hash, clients: peers() }), /not an executor-creation request/);
});

test("the binding landing must carry exactly one ExecutorBound for the verified executor", () => {
  const executor = predicted, dch = delegationCodeHash(executor);
  const bindData = encodeFunctionData({ abi: RESERVE_ABI, functionName: "bindExecutor", args: [executor] });
  const req3 = { stage: "bind", transaction: { ...req2.transaction, to: reserve, data: bindData, nonce: "0x45b" }, executor: { address: executor }, expectedDelegationCodeHash: dch };
  const log = (exec = executor, h = dch, address = reserve) => ({ address, topics: encodeEventTopics({ abi: RESERVE_ABI, eventName: "ExecutorBound" }),
    data: encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [exec, h]) });
  const tx = { hash, from: admin, to: reserve, chainId: 8453, type: "eip1559", nonce: 0x45b, input: bindData, value: 0n, gas: BigInt(req3.transaction.gas), maxFeePerGas: BigInt(req3.transaction.maxFeePerGas), maxPriorityFeePerGas: 1n };
  const receipt = (logs) => ({ transactionHash: hash, status: "success", logs });
  checkBindLanding(req3, { transaction: tx, receipt: receipt([log()]) });
  assert.throws(() => checkBindLanding(req3, { transaction: tx, receipt: receipt([]) }), /exactly one ExecutorBound/);
  assert.throws(() => checkBindLanding(req3, { transaction: tx, receipt: receipt([log(), log()]) }), /exactly one ExecutorBound/);
  assert.throws(() => checkBindLanding(req3, { transaction: tx, receipt: receipt([log("0x" + "77".repeat(20))]) }), /bound another executor/);
  assert.throws(() => checkBindLanding(req3, { transaction: tx, receipt: receipt([log(executor, dch, "0x" + "77".repeat(20))]) }), /exactly one ExecutorBound/);
  assert.throws(() => checkBindLanding(req3, { transaction: { ...tx, to: "0x" + "77".repeat(20) }, receipt: receipt([log()]) }), /wrong destination/);
  assert.throws(() => checkBindLanding(req2, { transaction: tx, receipt: receipt([log()]) }), /not a binding request/);
  assert.throws(() => checkExecutorLanding(req3, { transaction: tx, receipt: receipt([]), code: "0x" }), /not an executor-creation request/);
});

test("verifyBinding refuses the two earlier stages' hashes before reading the chain", async () => {
  const req3 = { stage: "bind", transaction: req2.transaction, reserve: { transactionHash: "0x" + "01".repeat(32) }, executor: { transactionHash: "0x" + "02".repeat(32) } };
  await assert.rejects(verifyBinding({ trust: PRODUCTION, request: req3, hash: "0x" + "01".repeat(32), clients: peers() }), /reserve's creation hash/);
  await assert.rejects(verifyBinding({ trust: PRODUCTION, request: req3, hash: "0x" + "02".repeat(32), clients: peers() }), /executor's creation hash/);
});
