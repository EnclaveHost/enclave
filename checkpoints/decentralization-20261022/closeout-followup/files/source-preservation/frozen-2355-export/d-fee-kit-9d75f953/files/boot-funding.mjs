#!/usr/bin/env node
// MANDATORY BOOT-FUNDING PREFLIGHT, READ-ONLY (root runs it standalone via funding.py; activate.py runs it again immediately
// before the restart). Adapted from work/custody-boot-registration-20261023/tools/estimate-boot-registration.mjs:
//   node boot-funding.mjs --rpc https://A --rpc https://B --commit <approved 40-hex> --supervisor-sha256 <hex> --decision-sha256 <hex>
//                         --sender-sha256 <hex> --out evidence/boot-funding.json   (common.boot_funding passes the APPROVED build.json's values)
// FEES (the 23:15 rollback: the previous kit MODELLED 7 mwei; viem 2.53.1's plain writeContract can be re-priced to ~13.2 mwei by
// eth_fillTransaction x 1.2 - a reproducible SDK failure scenario and the SUSPECTED production cause, NOT a confirmed live fee: root's
// direct mainnet probe at 23:19:59 fell back to 7 mwei): the boot transaction is priced THROUGH THE APPROVED COMMIT'S OWN sendOperatorTx (sliced from its
// supervisor.js, sha256-pinned in build.json), run against the image's own viem (H's node_modules, 2.53.1) with a NO-SIGN account:
// its writeContract hands exactly what the sender passes to viem's real prepareTransactionRequest (the step writeContract runs
// before signing). Every call is a read (eth_estimateGas / fee reads / eth_fillTransaction / nonce); nothing is signed or sent.
// It COLLECTS facts at one block two RPCs agree on; common.py boot_funding_problems() DECIDES. The boot decision is the approved
// commit's own bootRegistrationAction (git show <commit>:supervisor.js; the file AND the sliced function hash-checked against
// build.json), evaluated TWICE: with the GPU price PENDING (null: the new boot before shielded discovery) and DISCOVERED (1667),
// both for the fields the box registers
// (root 21:51Z: repo EnclaveHost/enclave, measurement 0, prices 834/1667) and the worst-case nonzero 20-byte test proof key
// 0xff..ff - fee estimation ONLY: the real boot key is minted inside the new boot. The fees are the APPROVED sender's own (below);
// no transaction, key or signing here.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { l1SizeArgument } from "./fee-fit.mjs";

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

// the boot sender of the APPROVED commit, sliced and hash-pinned like the decision
export const SENDER_RE = /function sendOperatorTx\(address, abi, functionName, args\) \{[\s\S]*?\n\}/g;
export function approvedSender(commit, repo = H_REPO, wantSender) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("--commit: 40 hex");
  if (!/^[0-9a-f]{64}$/.test(String(wantSender))) throw new Error("the approved sender hash is required");
  const src = execFileSync("git", ["-C", repo, "show", `${commit}:supervisor.js`], { maxBuffer: 64 << 20 }).toString("utf8");
  const m = src.match(SENDER_RE) || [];
  if (m.length !== 1) throw new Error(`${m.length} sendOperatorTx definitions at the approved commit, not exactly one`);
  const got = sha256(Buffer.from(m[0]));
  if (got !== wantSender) throw new Error(`sendOperatorTx at ${commit} is ${got.slice(0, 16)}, not the approved sender`);
  return { text: m[0], senderSha256: got };
}

/** Runs sender text (the image's own sendOperatorTx) once, inert: -> { sender: what it passed to writeContract, prepared: what
 *  viem's prepareTransactionRequest returns for it }. No key exists here; a signature attempt throws. */
export async function priceViaSender({ senderText, viem, accounts, chain, transport, operator, to, abi, functionName, args }) {
  const nosign = () => { throw new Error("inert preflight: no signing"); };
  const account = accounts.toAccount({ address: operator, signMessage: nosign, signTransaction: nosign, signTypedData: nosign });
  const chainClient = viem.createPublicClient({ chain, transport });
  const walletClient = viem.createWalletClient({ account, chain, transport });
  let sent = null;
  const wallet = { writeContract: async (req) => {
    const { address, abi: a, functionName: fn, args: ar, ...rest } = req;
    const prepared = await walletClient.prepareTransactionRequest({ ...rest, account, chain, to: address,
      data: viem.encodeFunctionData({ abi: a, functionName: fn, args: ar }) });
    sent = { request: rest, prepared }; return "0x" + "00".repeat(32);
  } };
  const scope = { claimSigner: () => ({ account, wallet }), chainClient, getAddress: viem.getAddress, awaitReceipt: async () => ({ status: "inert" }) };
  const make = new Function("scope", `const { claimSigner, chainClient, getAddress, awaitReceipt } = scope; let _txChain = Promise.resolve();\n${senderText}\nreturn sendOperatorTx;`);
  const p = make(scope)(to, abi, functionName, args);
  await p; await p.receipt;
  if (!sent) throw new Error("the sender never reached writeContract");
  const pick = (o) => ({ gas: o.gas ?? null, maxFeePerGas: o.maxFeePerGas ?? null, maxPriorityFeePerGas: o.maxPriorityFeePerGas ?? null });
  return { sender: pick(sent.request), prepared: { ...pick(sent.prepared), type: sent.prepared.type, nonce: sent.prepared.nonce } };
}

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
export async function collect({ call, rpcs, viem, accounts, chain, decide, sender, commit, supervisorSha256, bootDecisionSha256, now = () => new Date().toISOString() }) {
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
  const isthmus = await ethCall(PINS.oracle, ORACLE, "isIsthmus").catch(() => null);
  // the boot transaction as THE APPROVED SENDER sends it, once per RPC (each as one member of the node's pool), via the real SDK
  async function priceOn(u) {
    const transport = viem.custom({ request: ({ method, params }) => call(u, method, params ?? []) });
    const r = await priceViaSender({ senderText: sender.text, viem, accounts, chain, transport, operator: PINS.operator, to: PINS.registry, abi: REG,
      functionName: "setProofKey", args: [id, PINS.testProofKey] });
    const { gas, maxFeePerGas, maxPriorityFeePerGas } = r.prepared;
    if (typeof gas !== "bigint" || typeof maxFeePerGas !== "bigint" || typeof maxPriorityFeePerGas !== "bigint") throw new Error(`${u}: the prepared transaction carries no EIP-1559 gas/fees`);
    const data = viem.encodeFunctionData({ abi: REG, functionName: "setProofKey", args: [id, PINS.testProofKey] });
    const tx = { type: "eip1559", chainId: PINS.chainId, nonce: Number(nonce), to: PINS.registry, value: 0n, data, gas, maxFeePerGas, maxPriorityFeePerGas };
    const unsigned = (viem.serializeTransaction(tx).length - 2) / 2;
    const signedMax = (viem.serializeTransaction(tx, { r: "0x" + "ff".repeat(32), s: "0x" + "ff".repeat(32), yParity: 1 }).length - 2) / 2;
    const l1 = await ethCall(PINS.oracle, ORACLE, "getL1FeeUpperBound", [BigInt(l1SizeArgument({ unsigned, signedMax }))]);
    const op = isthmus === true ? await ethCall(PINS.oracle, ORACLE, "getOperatorFee", [gas]) : null;
    const sv = (x) => (x === null ? null : String(x));
    return { rpc: u, senderGas: sv(r.sender.gas), senderMaxFeePerGas: sv(r.sender.maxFeePerGas), senderMaxPriorityFeePerGas: sv(r.sender.maxPriorityFeePerGas),
      gas: String(gas), maxFeePerGas: String(maxFeePerGas), maxPriorityFeePerGas: String(maxPriorityFeePerGas), nonce: String(r.prepared.nonce), sizes: { unsigned, signedMax },
      l1FeeUpperBoundWei: String(l1), operatorFeeWei: op === null ? "UNDETERMINED" : String(op), worstCaseWei: String(gas * maxFeePerGas + l1 + (op ?? 0n)) };
  }
  const perRpc = [];
  for (const u of rpcs) perRpc.push(await priceOn(u));
  const worst = perRpc.map((x) => BigInt(x.worstCaseWei)).reduce((a, x) => (x > a ? x : a), 0n);
  const s = (x) => String(x);
  return {
    at: now(), readOnly: true, rpcs, chainIds, block: { number: s(n), hash: blk.hash, timestamp: s(BigInt(blk.timestamp)) },
    source: { commit, supervisorSha256, bootDecisionSha256, senderSha256: sender.senderSha256 },
    registry: { address: PINS.registry, codeHash: viem.keccak256(registryCode) },
    operator: { address: PINS.operator, code: operatorCode, nonceAtBlock: s(nonce), latest: latest.map(s), pending: pending.map(s), balanceWei: s(balance) },
    executor: { address: PINS.executor, codeHash: viem.keccak256(executorCode) },
    id, row: { operator: row.operator, active: row.active, endpoint: row.endpoint, repo: row.repo, measurement: row.measurement,
      cpu: s(row.cpuPricePerSec6), gpu: s(row.gpuPricePerSec6), proofKey: row.proofKey },
    desired: { ...desired, cpuPricePerSec6: s(desired.cpuPricePerSec6), gpuPricePerSec6: s(desired.gpuPricePerSec6) },
    desiredPending: { ...desired, cpuPricePerSec6: s(desired.cpuPricePerSec6), gpuPricePerSec6: null },
    testProofKey: PINS.testProofKey, actions,
    fees: { isthmus, pricedBy: "the approved sendOperatorTx + viem prepareTransactionRequest (inert, no signer)" },
    setProofKey: { perRpc, worstCaseWei: s(worst) },
    note: "bounds at this block only; the larger per-RPC worst case of the approved sender's own prepared setProofKey (worst-case test key) is what the gate checks",
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
  const sender = approvedSender(commit, H_REPO, one("sender-sha256"));
  const accounts = await import(pathToFileURL(path.join(H_REPO, "node_modules/viem/_esm/accounts/index.js")).href);
  const { base } = await import(pathToFileURL(path.join(H_REPO, "node_modules/viem/_esm/chains/index.js")).href);
  const viem = await import(pathToFileURL(path.join(H_REPO, "node_modules/viem/_esm/index.js")).href);
  const facts = await collect({ call: rpcCall, rpcs, viem, accounts, chain: base, decide, sender, commit, supervisorSha256, bootDecisionSha256 });
  fs.writeFileSync(out, JSON.stringify(facts, null, 1) + "\n");
  console.log(JSON.stringify({ block: facts.block.number, actions: facts.actions, balanceWei: facts.operator.balanceWei,
    setProofKeyWorstCaseWei: facts.setProofKey.worstCaseWei, prepared: facts.setProofKey.perRpc.map((x) => ({ rpc: x.rpc, gas: x.gas, maxFeePerGas: x.maxFeePerGas })), nonce: facts.operator.nonceAtBlock, pending: facts.operator.pending }));
}
