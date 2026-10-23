// The operator queue's fees, through the REAL SDK (2026-10-23, metal0): the supervisor's own claimSigner / sendOperatorTx /
// awaitReceipt, sliced from supervisor.js, run on real viem wallet + public clients for Base whose transport is a recording
// stub node. Nothing reaches a network; the key is a throwaway generated per run. The stub node answers eth_fillTransaction
// with a HIGHER fee (2 x base + tip, as a geth-family node fills) and a higher gas, so a path that lets the library fill
// and re-multiply is caught, and the fixed path is shown not to overbid quietly.
//   BASELINE (7dd3acd, the staged b007d471 image): writeContract with nothing set -> signed maxFeePerGas = 1.2 x the STUB
//   node's filled fee = 13.2 mwei at base 5 / tip 1. This demonstrates the SDK failure scenario (the suspected cause of
//   metal0's "insufficient funds"); it is not metal0's observed fee: whether a production RPC fills was not confirmed (a
//   direct mainnet.base.org probe did not fill and fell back to 7 mwei). A node that does not fill sees no difference.
//   FIX: estimateFeesPerGas (no fill) + estimateContractGas at those fees from the operator, explicit on the write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, custom, getAddress, encodeFunctionData, keccak256, parseTransaction,
         recoverTransactionAddress, decodeFunctionData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { base } from "viem/chains";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// ../mutants-fee.sh points this at a mutated copy; normally the repo's own file
const CURRENT = fs.readFileSync(process.env.OPERATOR_FEE_SUPERVISOR || path.join(REPO, "supervisor.js"), "utf8");
const BASELINE = execFileSync("git", ["-C", REPO, "show", "7dd3acd061af765cdcd9ba21b9744f2f2c6bdf5b:supervisor.js"], { maxBuffer: 64 << 20 }).toString();
const slice = (src, re, what) => { const m = re.exec(src); assert.ok(m, `${what} in supervisor.js`); return m[0]; };
const PIECES = (src) => [
  slice(src, /let _claimAccount = null, _claimWallet = null, _txChain = Promise\.resolve\(\);\nfunction claimSigner\(\) \{[\s\S]*?\n\}/, "claimSigner"),
  slice(src, /async function awaitReceipt\(hash, timeoutMs = 90_000\) \{[\s\S]*?\n\}/, "awaitReceipt"),
  slice(src, /function sendOperatorTx\(address, abi, functionName, args\) \{[\s\S]*?\n\}/, "sendOperatorTx"),
].join("\n");

const REGISTRY = "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac";
const ABI = [{ type: "function", name: "setProofKey", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [] }];
const ID = "0x" + "4d".repeat(32), KEY = "0x" + "ff".repeat(20);
const BASE_FEE = 5_000_000n, TIP = 1_000_000n, NONCE = 23759, EST_GAS = 38772n, FILL_GAS = 60000n, FILL_FEE = 2n * BASE_FEE + TIP;
const hex = (n) => "0x" + BigInt(n).toString(16);

// A stub Base node: records every request; `fail` makes a method answer an RPC error; `fill` = "unsupported" -> method not found
function node({ fail = {}, fill = "higher", receiptStatus = "0x1" } = {}) {
  const calls = [], sent = [];
  const block = { number: "0x328bf00", hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), timestamp: "0x6a1b2c3d",
    baseFeePerGas: hex(BASE_FEE), gasLimit: "0x2faf080", gasUsed: "0x0", miner: "0x" + "00".repeat(20), extraData: "0x", nonce: "0x0000000000000000",
    difficulty: "0x0", totalDifficulty: "0x0", size: "0x100", logsBloom: "0x" + "00".repeat(256), transactions: [], uncles: [],
    sha3Uncles: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), transactionsRoot: "0x" + "00".repeat(32), mixHash: "0x" + "00".repeat(32) };
  const err = (code, message) => Object.assign(new Error(message), { code });
  async function request({ method, params }) {
    calls.push({ method, params });
    if (fail[method]) throw err(fail[method].code ?? -32000, fail[method].message ?? `${method} failed`);
    switch (method) {
      case "eth_chainId": return hex(8453);
      case "eth_blockNumber": return block.number;
      case "eth_getBlockByNumber": return block;
      case "eth_maxPriorityFeePerGas": return hex(TIP);
      case "eth_getTransactionCount": return hex(NONCE);
      case "eth_estimateGas": return hex(EST_GAS);
      case "eth_fillTransaction": {
        if (fill === "unsupported") throw err(-32601, "the method eth_fillTransaction does not exist/is not available");
        const t = params[0];
        return { raw: "0x", tx: { type: "0x2", chainId: hex(8453), nonce: hex(NONCE), from: t.from, to: t.to, input: t.data, value: "0x0",
          gas: hex(FILL_GAS), maxFeePerGas: hex(FILL_FEE), maxPriorityFeePerGas: hex(TIP), accessList: [],
          hash: "0x" + "00".repeat(32), r: "0x0", s: "0x0", v: "0x0", yParity: "0x0" } };
      }
      case "eth_sendRawTransaction": {
        const raw = params[0];
        sent.push({ raw, tx: parseTransaction(raw), from: await recoverTransactionAddress({ serializedTransaction: raw }) });
        return keccak256(raw);
      }
      case "eth_getTransactionReceipt": return { transactionHash: params[0], blockHash: block.hash, blockNumber: block.number, transactionIndex: "0x0",
        from: "0x" + "00".repeat(20), to: REGISTRY, cumulativeGasUsed: hex(EST_GAS), gasUsed: hex(EST_GAS), effectiveGasPrice: hex(BASE_FEE + TIP),
        contractAddress: null, logs: [], logsBloom: block.logsBloom, status: receiptStatus, type: "0x2" };
    }
    throw err(-32601, `stub node: ${method} not stubbed`);
  }
  return { request, calls, sent, methods: () => calls.map((c) => c.method) };
}

// one supervisor operator queue over that node, with the supervisor's own functions
function queue(src, n) {
  const PK = generatePrivateKey();
  const transport = custom({ request: n.request });
  const make = new Function("REGISTRY_PK", "privateKeyToAccount", "createWalletClient", "base", "rpcTransport", "chainClient", "getAddress", "sleepMs", `
    ${PIECES(src)}
    return { sendOperatorTx, claimSigner };`);
  const q = make(PK, privateKeyToAccount, createWalletClient, base, () => transport,
    createPublicClient({ chain: base, transport }), getAddress, () => new Promise((r) => setImmediate(r)));
  return { ...q, operator: privateKeyToAccount(PK).address };
}
const send = (q) => q.sendOperatorTx(REGISTRY, ABI, "setProofKey", [ID, KEY]);

test("BASELINE (7dd3acd), SDK scenario: where the node fills, writeContract with nothing set re-multiplies the filled fee: 13.2 mwei signed against this stub", async () => {
  const n = node(), q = queue(BASELINE, n);
  await send(q);
  assert.ok(n.methods().includes("eth_fillTransaction"));
  assert.equal(n.sent.length, 1);
  assert.equal(n.sent[0].tx.maxFeePerGas, (FILL_FEE * 12n) / 10n, "1.2 x the node's 11 mwei");
  assert.equal(n.sent[0].tx.maxFeePerGas, 13_200_000n);
  assert.equal(n.sent[0].tx.gas, FILL_GAS, "and the node's gas");
});

// What viem 2.53.1 actually does for a LOCAL account (read from its source, pinned by the cases below): estimateFeesPerGas reads
// the block and eth_maxPriorityFeePerGas (no fill); estimateContractGas -> estimateGas -> prepareTransactionRequest TRIES
// eth_fillTransaction with the request (here: the explicit fees) and returns the node's filled gas, or, where the node
// does not fill, calls eth_estimateGas; writeContract with gas and fees given still asks the node to fill (for the nonce)
// but keeps the caller's gas and fees and does not multiply them (fillTransaction.js: "Preference supplied fees").
test("FIX: the signed fees are estimateFeesPerGas (1.2 x base + tip), never the node's filled fee re-multiplied; gas is the node's estimate at those fees", async () => {
  for (const fill of ["higher", "unsupported"]) {
    const n = node({ fill }), q = queue(CURRENT, n);
    const hash = await send(q);
    assert.equal(n.sent.length, 1, fill);
    const { tx, from, raw } = n.sent[0];
    assert.equal(hash, keccak256(raw), fill);
    assert.equal(tx.maxFeePerGas, 7_000_000n, `${fill}: ceil(1.2 x 5) + 1 mwei, not the fill path's ${FILL_FEE * 12n / 10n}`);
    assert.equal(tx.maxPriorityFeePerGas, TIP, fill);
    // gas: the node's own estimate for THIS request at THOSE fees - its fill answer where it fills, else eth_estimateGas
    assert.equal(tx.gas, fill === "higher" ? FILL_GAS : EST_GAS, fill);
    assert.equal(tx.type, "eip1559", fill);
    assert.equal(tx.chainId, 8453, fill);
    assert.equal(tx.nonce, NONCE, `${fill}: the account nonce, as before`);
    assert.equal(tx.value ?? 0n, 0n, fill);
    assert.equal(from, q.operator, `${fill}: signed by the operator key`);
    assert.equal(getAddress(tx.to), getAddress(REGISTRY), fill);
    assert.deepEqual(decodeFunctionData({ abi: ABI, data: tx.data }), { functionName: "setProofKey", args: [ID, getAddress(KEY)] }, fill);
    // every question put to the node about this transaction was asked FROM the operator AT the fees then signed
    const asked = n.calls.filter((c) => c.method === "eth_fillTransaction" || c.method === "eth_estimateGas");
    assert.ok(asked.length >= 1, fill);
    for (const c of asked) {
      assert.equal(getAddress(c.params[0].from), q.operator, `${fill}: ${c.method} from the operator`);
      assert.equal(BigInt(c.params[0].maxFeePerGas), 7_000_000n, `${fill}: ${c.method} at the signed fee`);
      assert.equal(BigInt(c.params[0].maxPriorityFeePerGas), TIP, fill);
      assert.equal(c.params[0].data, encodeFunctionData({ abi: ABI, functionName: "setProofKey", args: [ID, KEY] }), fill);
    }
    // the fees came from the block + eth_maxPriorityFeePerGas, read BEFORE anything was filled
    const m = n.methods();
    assert.ok(m.indexOf("eth_maxPriorityFeePerGas") >= 0 && m.indexOf("eth_maxPriorityFeePerGas") < m.indexOf(fill === "higher" ? "eth_fillTransaction" : "eth_estimateGas"), `${fill}: ${m.join(",")}`);
  }
});

test("a failed fee read or gas estimate signs and sends NOTHING", async () => {
  const revert = { code: 3, message: "execution reverted" };
  for (const [label, opts] of [
    ["fill reverts", { fail: { eth_fillTransaction: revert } }],
    ["no fill, estimate reverts", { fill: "unsupported", fail: { eth_estimateGas: revert } }],
    ["no fill, estimate: insufficient funds", { fill: "unsupported", fail: { eth_estimateGas: { message: "insufficient funds for gas * price + value" } } }],
    ["priority fee unreadable", { fail: { eth_maxPriorityFeePerGas: {} } }],
    ["block unreadable", { fail: { eth_getBlockByNumber: {} } }]]) {
    const n = node(opts), q = queue(CURRENT, n);
    const p = send(q);
    await assert.rejects(p, undefined, label);
    await assert.rejects(p.receipt, undefined, label);
    assert.equal(n.sent.length, 0, `${label}: nothing broadcast`);
    assert.ok(!n.methods().includes("eth_sendRawTransaction"), label);
  }
});

test("the queue still serializes through confirmation, and a reverted receipt is reported as before", async () => {
  const n = node({ receiptStatus: "0x0" }), q = queue(CURRENT, n);
  const a = send(q), b = send(q);
  const [ra, rb] = [await a.receipt, await b.receipt];
  assert.equal(ra.status, "reverted"); assert.equal(rb.status, "reverted");
  const m = n.methods();
  // b's fee read starts only after a's receipt was read
  const aReceipt = m.indexOf("eth_getTransactionReceipt"), bFees = m.indexOf("eth_maxPriorityFeePerGas", m.indexOf("eth_sendRawTransaction") + 1);
  assert.ok(aReceipt > 0 && bFees > aReceipt, `order: ${m.join(",")}`);
  assert.equal(n.sent.length, 2);
  // and after a failed one, the next transaction is still sent
  let estimates = 0;
  const m2 = node({ fill: "unsupported" }); const req = m2.request;
  m2.request = async (r) => { if (r.method === "eth_estimateGas" && ++estimates === 1) { m2.calls.push(r); throw Object.assign(new Error("boom"), { code: -32000 }); } return req(r); };
  const q2 = queue(CURRENT, m2);
  const f = send(q2); f.catch(() => {}); f.receipt.catch(() => {});
  const g = send(q2);
  await assert.rejects(f);
  await g; assert.equal(m2.sent.length, 1, "the one after the failure is sent");
});
