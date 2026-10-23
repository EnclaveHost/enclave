#!/usr/bin/env node
// MANDATORY BOOT-FUNDING PREFLIGHT, READ-ONLY (root runs it standalone via funding.py; activate.py runs it again immediately
// before the restart). Adapted from work/custody-boot-registration-20261023/tools/estimate-boot-registration.mjs:
//   node boot-funding.mjs --rpc https://A --rpc https://B --commit <approved 40-hex> --supervisor-sha256 <hex> --decision-sha256 <hex>
//                         --out evidence/boot-funding.json      (common.boot_funding passes the APPROVED build.json's values)
// It COLLECTS facts at one block two RPCs agree on; common.py boot_funding_problems() DECIDES. The boot decision is the approved
// commit's own bootRegistrationAction (git show <commit>:supervisor.js; the file AND the sliced function hash-checked against
// build.json), evaluated TWICE: with the GPU price PENDING (null: the new boot before shielded discovery) and DISCOVERED (1667),
// both for the fields the box registers
// (root 21:51Z: repo EnclaveHost/enclave, measurement 0, prices 834/1667) and the worst-case nonzero 20-byte test proof key
// 0xff..ff - fee estimation ONLY: the real boot key is minted inside the new boot. The supervisor sends with viem's default fees
// (maxFee = ceil(1.2 x base) + tip) through the existing default sender, unchanged; no transaction, key or signing here.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { feeFit, l1SizeArgument, viemDefaultMaxFee } from "./fee-fit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const H_REPO = path.resolve(HERE, "../custody-boot-registration-20261023/repo");
export const PINS = Object.freeze({
  chainId: 8453,
  registry: "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac",
  endpoint: "https://api.enclave.host/t/metal0",
  operator: "0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab",
  executor: "0x8900baca2167873ba2f8a8bae8b4876e6396d343",
  oracle: "0x420000000000000000000000000000000000000f",
  repo: "EnclaveHost/enclave",
  measurement: "0x" + "00".repeat(32),
  cpu: 834n,
  gpu: 1667n,
  testProofKey: "0x" + "ff".repeat(20),
});
export const ROW = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
  { name: "endpoint", type: "string" }, { name: "repo", type: "string" }, { name: "measurement", type: "bytes32" }, { name: "operator", type: "address" },
  { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" }, { name: "active", type: "bool" }, { name: "cpuPricePerSec6", type: "uint64" },
  { name: "gpuPricePerSec6", type: "uint64" }, { name: "proofKey", type: "address" }, { name: "payoutWallet", type: "address" }] }] }];
export const REG = [
  { type: "function", name: "setProofKey", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [] },
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ type: "string" }, { type: "string" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }, { type: "address" }], outputs: [{ type: "bytes32" }] },
];
export const ORACLE = [{ type: "function", name: "getL1FeeUpperBound", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isIsthmus", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "getOperatorFee", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] }];

// the decision function of the APPROVED commit (no second implementation, never the working tree): supervisor.js and the sliced
// function must both hash to the approved build.json's values
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
export function reviewedDecision(commit, repo = H_REPO, wantSupervisor, wantDecision) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("--commit: 40 hex");
  if (!/^[0-9a-f]{64}$/.test(String(wantSupervisor)) || !/^[0-9a-f]{64}$/.test(String(wantDecision))) throw new Error("the approved supervisor/decision hashes are required");
  const src = execFileSync("git", ["-C", repo, "show", `${commit}:supervisor.js`], { maxBuffer: 64 << 20 });
  const got = sha256(src);
  if (got !== wantSupervisor) throw new Error(`supervisor.js at ${commit} is ${got.slice(0, 16)}, not the approved bytes`);
  const m = src.toString("utf8").match(/function bootRegistrationAction\(row, want\) \{[\s\S]*?\n\}/g) || [];
  if (m.length !== 1) throw new Error(`${m.length} bootRegistrationAction definitions at the approved commit, not exactly one`);
  const dec = sha256(Buffer.from(m[0]));
  if (dec !== wantDecision) throw new Error(`bootRegistrationAction at ${commit} is ${dec.slice(0, 16)}, not the approved decision`);
  return { decide: new Function(`${m[0]}; return bootRegistrationAction;`)(), supervisorSha256: got, bootDecisionSha256: dec };
}

// Two RPCs see the same block when its canonical fields agree. Root's 22:07/22:08 runs failed on whole-object JSON equality:
// the bounded probe (logs/probe2.out) found publicnode and mainnet.base.org returning the SAME fields and values in a different
// property ORDER (round 5 of 10). Provider metadata and order are ignored; number/hash/parentHash/timestamp must be equal.
export const CANONICAL_BLOCK = ["number", "hash", "parentHash", "timestamp"];
export function sameBlock(x, y) {
  return !!x && !!y && CANONICAL_BLOCK.every((k) => typeof x[k] === "string" && typeof y[k] === "string" && x[k].toLowerCase() === y[k].toLowerCase());
}

// call(url, method, params) -> JSON-RPC result (throws on error). Every chain fact: both RPCs, one block (2 deep), agreement.
export async function collect({ call, rpcs, viem, decide, commit, supervisorSha256, bootDecisionSha256, now = () => new Date().toISOString() }) {
  if (rpcs.length !== 2 || rpcs[0] === rpcs[1]) throw new Error("exactly two distinct RPCs");
  const both = (method, params) => Promise.all(rpcs.map((u) => call(u, method, params)));
  const agree = async (what, method, params) => { const r = await both(method, params); if (JSON.stringify(r[0]) !== JSON.stringify(r[1])) throw new Error(`RPCs disagree on ${what}`); return r[0]; };
  const chainIds = (await both("eth_chainId", [])).map(Number);
  if (chainIds.some((x) => x !== PINS.chainId)) throw new Error("not Base");
  const heads = (await both("eth_blockNumber", [])).map(BigInt);
  const n = (heads[0] < heads[1] ? heads[0] : heads[1]) - 2n;
  const blocks = await both("eth_getBlockByNumber", ["0x" + n.toString(16), false]);
  if (!sameBlock(blocks[0], blocks[1])) throw new Error(`RPCs disagree on block ${n} (${CANONICAL_BLOCK.join("/")})`);
  if (BigInt(blocks[0].number) !== n) throw new Error(`asked for block ${n}, got ${blocks[0].number}`);
  const blk = blocks[0];
  const at = { blockHash: blk.hash, requireCanonical: true };
  const ethCall = async (to, abi, fn, args = []) => viem.decodeFunctionResult({ abi, functionName: fn,
    data: await agree(fn, "eth_call", [{ to, data: viem.encodeFunctionData({ abi, functionName: fn, args }) }, at]) });
  const registryCode = await agree("registry code", "eth_getCode", [PINS.registry, at]);
  const operatorCode = await agree("operator code", "eth_getCode", [PINS.operator, at]);
  const executorCode = await agree("executor code", "eth_getCode", [PINS.executor, at]);
  const id = viem.keccak256(viem.stringToBytes(PINS.endpoint));
  const row = await ethCall(PINS.registry, ROW, "get", [id]);
  const desired = { operator: PINS.operator, endpoint: PINS.endpoint, repo: PINS.repo, measurement: PINS.measurement,
    cpuPricePerSec6: PINS.cpu, gpuPricePerSec6: PINS.gpu, proofKey: PINS.testProofKey };
  // the new boot BEFORE shielded discovery asks with a pending (null) GPU price; after discovery with the card's 1667
  const actions = { pending: decide(row, { ...desired, gpuPricePerSec6: null }), discovered: decide(row, desired) };
  const nonce = BigInt(await agree("nonce", "eth_getTransactionCount", [PINS.operator, at]));
  const latest = (await both("eth_getTransactionCount", [PINS.operator, "latest"])).map(BigInt);
  const pending = (await both("eth_getTransactionCount", [PINS.operator, "pending"])).map(BigInt);
  const balance = BigInt(await agree("balance", "eth_getBalance", [PINS.operator, at]));
  const tops = await both("eth_getBlockByNumber", ["latest", false]);
  const baseFee = tops.map((b) => BigInt(b.baseFeePerGas)).reduce((a, x) => (x > a ? x : a), 0n);
  const tip = (await both("eth_maxPriorityFeePerGas", [])).map(BigInt).reduce((a, x) => (x > a ? x : a), 0n);
  const isthmus = await ethCall(PINS.oracle, ORACLE, "isIsthmus").catch(() => null);
  const maxFee = viemDefaultMaxFee(baseFee, tip);
  async function price(fn, args) {
    const data = viem.encodeFunctionData({ abi: REG, functionName: fn, args });
    const estimates = (await both("eth_estimateGas", [{ from: PINS.operator, to: PINS.registry, data }, "0x" + n.toString(16)])).map(BigInt);
    const gas = estimates.reduce((a, x) => (x > a ? x : a), 0n);
    const tx = { type: "eip1559", chainId: PINS.chainId, nonce: Number(nonce), to: PINS.registry, value: 0n, data, gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
    const unsigned = (viem.serializeTransaction(tx).length - 2) / 2;
    const signedMax = (viem.serializeTransaction(tx, { r: "0x" + "ff".repeat(32), s: "0x" + "ff".repeat(32), yParity: 1 }).length - 2) / 2;
    const l1 = await ethCall(PINS.oracle, ORACLE, "getL1FeeUpperBound", [BigInt(l1SizeArgument({ unsigned, signedMax }))]);
    const op = isthmus === true ? await ethCall(PINS.oracle, ORACLE, "getOperatorFee", [gas]) : null;
    return { fn, gasEstimates: estimates.map(String), sizes: { unsigned, signedMax }, l1FeeUpperBoundWei: String(l1),
      operatorFeeWei: op === null ? "UNDETERMINED" : String(op), ...feeFit({ gas, baseFee, tip, l1FeeUpperBound: l1, operatorFee: op ?? 0n, balance }) };
  }
  const s = (x) => String(x);
  return {
    at: now(), readOnly: true, rpcs, chainIds, block: { number: s(n), hash: blk.hash, timestamp: s(BigInt(blk.timestamp)) },
    source: { commit, supervisorSha256, bootDecisionSha256 },
    registry: { address: PINS.registry, codeHash: viem.keccak256(registryCode) },
    operator: { address: PINS.operator, code: operatorCode, nonceAtBlock: s(nonce), latest: latest.map(s), pending: pending.map(s), balanceWei: s(balance) },
    executor: { address: PINS.executor, codeHash: viem.keccak256(executorCode) },
    id, row: { operator: row.operator, active: row.active, endpoint: row.endpoint, repo: row.repo, measurement: row.measurement,
      cpu: s(row.cpuPricePerSec6), gpu: s(row.gpuPricePerSec6), proofKey: row.proofKey },
    desired: { ...desired, cpuPricePerSec6: s(desired.cpuPricePerSec6), gpuPricePerSec6: s(desired.gpuPricePerSec6) },
    desiredPending: { ...desired, cpuPricePerSec6: s(desired.cpuPricePerSec6), gpuPricePerSec6: null },
    testProofKey: PINS.testProofKey, actions,
    fees: { baseFeeWei: s(baseFee), tipWei: s(tip), viemDefaultMaxFeePerGas: s(maxFee), isthmus },
    setProofKey: await price("setProofKey", [id, PINS.testProofKey]),
    registerForComparison: await price("register", [PINS.endpoint, PINS.repo, PINS.measurement, PINS.cpu, PINS.gpu, PINS.testProofKey]).catch((e) => ({ error: e.message })),
    note: "bounds at this block only; the setProofKey worst case at viem's default fees, for the worst-case test key, is what the gate checks",
  };
}

export async function rpcCall(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000), redirect: "error" });
  const j = await r.json();
  if (j.error) throw new Error(`${new URL(url).host} ${method}: ${j.error.message}`);
  return j.result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const all = (k) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));
  const one = (k) => { const v = all(k); if (v.length !== 1) throw new Error(`--${k} exactly once`); return v[0]; };
  const rpcs = all("rpc");
  if (rpcs.length !== 2 || rpcs[0] === rpcs[1] || rpcs.some((u) => !/^https:\/\//.test(u))) throw new Error("exactly two distinct https --rpc");
  const commit = one("commit"), out = one("out");
  const { decide, supervisorSha256, bootDecisionSha256 } = reviewedDecision(commit, H_REPO, one("supervisor-sha256"), one("decision-sha256"));
  const viem = await import(pathToFileURL(path.join(H_REPO, "node_modules/viem/_esm/index.js")).href);
  const facts = await collect({ call: rpcCall, rpcs, viem, decide, commit, supervisorSha256, bootDecisionSha256 });
  fs.writeFileSync(out, JSON.stringify(facts, null, 1) + "\n");
  console.log(JSON.stringify({ block: facts.block.number, actions: facts.actions, balanceWei: facts.operator.balanceWei,
    setProofKeyWorstCaseWei: facts.setProofKey.worstCaseWei, nonce: facts.operator.nonceAtBlock, pending: facts.operator.pending }));
}
