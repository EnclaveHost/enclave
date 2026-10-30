// windows/node/host-onchain.mjs (the OWNER's CLI) under the node's explicit chain authority (windows-owner-cli-stage; PREPARED,
// NOT RUN by Claude). The REAL CLI runs as a child process (exactly as an owner runs it: argv + env) against loopback JSON-RPC
// recorders - the local VERIFIER, the operator-owned BACKEND, and a PUBLIC sentinel standing in for BASE_RPCS - which share
// one fake chain state. Every request each recorder receives is recorded and asserted. The fake verifier serves no proofs:
// these tests prove routing, binding, gating, receipt handling and refusals, not proof verification (the real verifier's job).
// OUTPUT CONTRACT (r2): status and ownership-status print exactly ONE JSON document on stdout (the whole stdout is parsed, no
// stripping); chain.mjs's authority diagnostic is on stderr and is asserted there (it is not dropped).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toFunctionSelector, encodeFunctionResult, encodeAbiParameters, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = (p) => fileURLToPath(new URL("../" + p, import.meta.url));
const CLI = root("windows/node/host-onchain.mjs"), PINS_FILE = root("contracts/deployments/contract-pins-base.json");
const AUTHORITIES = JSON.parse(fs.readFileSync(root("contracts/deployments/independent-authorities-base.json"), "utf8"));
const PINS = JSON.parse(fs.readFileSync(PINS_FILE, "utf8")).contracts;
const OWNERSHIP = AUTHORITIES.addresses.EnclaveHostOwnership.toLowerCase();
// the production registry ABI, taken from chain.mjs itself (no copy that could drift)
const REGISTRY_ABI = (0, eval)(fs.readFileSync(root("windows/node/chain.mjs"), "utf8").match(/const REGISTRY_ABI = (\[[\s\S]*?\n\]);/)[1]);
const OWNER_KEY = "0x" + "11".repeat(32), OWNER = privateKeyToAccount(OWNER_KEY).address;
const ENDPOINT = "https://box.example", HOST_ID = keccak256(toBytes(ENDPOINT));
const OPERATOR = "0x" + "0a".repeat(20), CONTRACT_WALLET = "0x" + "99".repeat(20), ZERO = "0x" + "00".repeat(20), Z32 = "0x" + "00".repeat(32);
const HEAD = 0x64, TXH = "0x" + "cd".repeat(32), HASH = "0x" + "ab".repeat(32);
const SEL = { get: toFunctionSelector("get(bytes32)"), setPayout: toFunctionSelector("setPayoutWallet(bytes32)"),
  registry: toFunctionSelector("registry()"), authority: toFunctionSelector("authority(bytes32)") };

/** One fake chain shared by the recorders: the registry entry (payoutWallet flips when a setPayoutWallet submission lands). */
const chainState = () => ({ payoutWallet: ZERO, receipts: true, receiptStatus: "0x1", landed: [] });
async function recorder(role, st, { down = false, chainId = "0x2105" } = {}) {
  const calls = [], TS = "0x" + Math.floor(Date.now() / 1000).toString(16);
  const blk = (n) => ({ number: "0x" + n.toString(16), hash: HASH, parentHash: "0x" + "aa".repeat(32), timestamp: TS, stateRoot: Z32, receiptsRoot: Z32,
    transactionsRoot: Z32, baseFeePerGas: "0x3b9aca00", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: ZERO, difficulty: "0x0", totalDifficulty: "0x0",
    extraData: "0x", logsBloom: "0x" + "00".repeat(256), mixHash: Z32, nonce: "0x0000000000000000", sha3Uncles: Z32, size: "0x1", transactions: [], uncles: [] });
  const entry = () => encodeFunctionResult({ abi: REGISTRY_ABI, functionName: "get", result: { endpoint: ENDPOINT, repo: "r", measurement: Z32, operator: OPERATOR,
    registeredAt: 1n, lastSeen: 1n, active: true, cpuPricePerSec6: 1n, gpuPricePerSec6: 0n, proofKey: ZERO, payoutWallet: st.payoutWallet } });
  const answer = (m, p) => {
    if (m === "eth_chainId") return chainId;
    if (m === "eth_blockNumber") return "0x" + HEAD.toString(16);
    if (m === "eth_getBlockByNumber") return blk(p[0] === "latest" || p[0] === "pending" ? HEAD : Number(BigInt(p[0])));
    if (m === "eth_getBlockByHash") return blk(HEAD);
    if (m === "eth_maxPriorityFeePerGas" || m === "eth_gasPrice") return "0x1";
    if (m === "eth_feeHistory") return { oldestBlock: "0x63", baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], gasUsedRatio: [0.5], reward: [["0x1"]] };
    if (m === "eth_getTransactionCount") return "0x3";
    if (m === "eth_sendRawTransaction") { st.landed.push(p[0]); if (role !== "verifier") st.payoutWallet = OWNER; return TXH; }
    if (m === "eth_getBalance") return "0xde0b6b3a7640000";                      // 1 ETH
    if (m === "eth_estimateGas") return "0x5208";
    if (m === "eth_getCode") return String(p[0]).toLowerCase() === OWNERSHIP ? "0x6001" : "0x";
    if (m === "eth_getTransactionReceipt") return st.receipts && p[0] === TXH ? { transactionHash: TXH, transactionIndex: "0x0", blockHash: HASH,
      blockNumber: "0x" + HEAD.toString(16), from: OWNER, to: OPERATOR, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca01",
      contractAddress: null, logs: [], logsBloom: "0x" + "00".repeat(256), status: st.receiptStatus, type: "0x2" } : null;
    if (m === "eth_getTransactionByHash") return null;
    if (m === "eth_call") {
      const to = String(p[0].to).toLowerCase(), sel = String(p[0].data).slice(0, 10);
      if (to === PINS.registry && sel === SEL.get) return entry();
      if (to === PINS.registry && sel === SEL.setPayout) return "0x";
      if (to === OWNERSHIP && sel === SEL.registry) return encodeAbiParameters([{ type: "address" }], [PINS.registry]);
      if (to === OWNERSHIP && sel === SEL.authority) return encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint64" }, { type: "bytes32" }],
        [CONTRACT_WALLET, ZERO, 1n, Z32]);
      return "0x";
    }
    return null;
  };
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      const one = (r) => { calls.push({ method: r.method, params: r.params }); return { jsonrpc: "2.0", id: r.id, result: answer(r.method, r.params || []) }; };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  if (down) await new Promise((r) => server.close(r));
  return { url, calls, methods: () => calls.map((c) => c.method), close: () => new Promise((r) => (down ? r() : server.close(r))) };
}
/** Run the REAL CLI. -> {code, out, err, timedOut}. */
function cli(args, env, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const keep = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BASE_RPCS|ENCLAVE_|OWNER_KEY|PUBLIC_URL|NODE_NAME|NODE_OPERATOR_KEY)/.test(k)));
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...keep, PUBLIC_URL: ENDPOINT, ENCLAVE_CONTRACT_PINS_FILE: PINS_FILE, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c));
    const t = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, timeoutMs);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err, timedOut }); });
  });
}
const OWN = (v, b) => ({ ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: v.url, ...(b ? { ENCLAVE_CHAIN_TX_BACKEND: b.url } : {}) });
async function world(opts = {}) {
  const st = chainState();
  const v = await recorder("verifier", st, opts.verifier), b = await recorder("backend", st, opts.backend), pub = await recorder("public", st);
  return { st, v, b, pub, close: async () => { await v.close(); await b.close(); await pub.close(); } };
}

test("status under the verifier: the registry entry and the owner balance are read from the verifier only; nothing is sent", async () => {
  const w = await world();
  try {
    const r = await cli(["status"], { ...OWN(w.v, w.b), OWNER_KEY });
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(r.out);                                   // the WHOLE stdout is the one JSON document
    assert.match(r.err, /\[chain\] authority: local verifier \S+.*\(unsafe tier, no L1 finality\)/, "the authority diagnostic is on stderr");
    assert.doesNotMatch(r.out, /\[chain\]/, "no diagnostic on stdout");
    assert.equal(j.registered, true); assert.equal(j.entry.operator.toLowerCase(), OPERATOR); assert.equal(j.ownerEth, "1"); assert.equal(j.enclaveId, HOST_ID);
    assert.ok(w.v.calls.some((c) => c.method === "eth_call" && String(c.params[0].to).toLowerCase() === PINS.registry), "the registry entry comes from the verifier");
    assert.ok(w.v.methods().includes("eth_getBalance"));
    assert.equal(w.b.calls.length, 0, `nothing is asked of the backend for a read-only command: ${w.b.methods()}`);
    assert.equal(w.pub.calls.length, 0, `public contacted: ${w.pub.methods()}`);
  } finally { await w.close(); }
});

test("fund-operator under the verifier: gated, bound backend submission, pending nonce from the backend, verified receipt; never the verifier, never public", async () => {
  const w = await world();
  try {
    const r = await cli(["fund-operator", OPERATOR, "0.0004"], { ...OWN(w.v, w.b), OWNER_KEY });
    assert.equal(r.code, 0, r.err); assert.match(r.out, /funded 0x0a0a/i); assert.match(r.out, new RegExp(`tx=${TXH}`));
    const bm = w.b.methods(), si = bm.indexOf("eth_sendRawTransaction");
    assert.ok(si > 0 && bm.slice(0, si).includes("eth_chainId") && bm.slice(0, si).includes("eth_getBlockByNumber"), `the backend is bound before the send: ${bm}`);
    assert.equal(bm.filter((m) => m === "eth_sendRawTransaction").length, 1, "exactly one submission");
    assert.ok(w.b.calls.some((c) => c.method === "eth_getTransactionCount" && c.params?.[1] === "pending"), "the pending nonce is the backend's");
    assert.ok(!w.v.methods().includes("eth_sendRawTransaction"), "never a transaction to the read-only verifier");
    assert.ok(w.v.methods().includes("eth_getTransactionReceipt") && !bm.includes("eth_getTransactionReceipt"), "the receipt comes from the verifier only");
    assert.equal(w.pub.calls.length, 0, `public contacted: ${w.pub.methods()}`);
  } finally { await w.close(); }
});

test("declare-payout under the verifier: simulate on the verifier, gated submission to the backend, the payout wallet read back from the verifier", async () => {
  const w = await world();
  try {
    const r = await cli(["declare-payout"], { ...OWN(w.v, w.b), OWNER_KEY });
    assert.equal(r.code, 0, r.err); assert.match(r.out, new RegExp(`setPayoutWallet: ${TXH}`));
    assert.match(r.out, new RegExp(`payout wallet on chain: ${OWNER}`, "i"), "the new payout wallet is read back after the receipt");
    assert.ok(w.v.calls.some((c) => c.method === "eth_call" && String(c.params[0].data).startsWith(SEL.setPayout)), "the simulation runs on the verifier");
    assert.equal(w.b.methods().filter((m) => m === "eth_sendRawTransaction").length, 1);
    assert.equal(w.pub.calls.length, 0);
  } finally { await w.close(); }
});

test("pool acceptance is never inclusion: no verified receipt -> no success; a reverted receipt -> refused", async () => {
  const w = await world(); w.st.receipts = false;
  try {
    const r = await cli(["fund-operator", OPERATOR, "0.0004"], { ...OWN(w.v, w.b), OWNER_KEY }, 15_000);
    assert.equal(w.b.methods().filter((m) => m === "eth_sendRawTransaction").length, 1, "the backend accepted the transaction");
    assert.ok(r.timedOut || r.code !== 0, "it never finishes as a success without a verified receipt");
    assert.doesNotMatch(r.out, /funded/, "nothing is reported as funded");
  } finally { await w.close(); }
  const w2 = await world(); w2.st.receiptStatus = "0x0";
  try {
    const r = await cli(["fund-operator", OPERATOR, "0.0004"], { ...OWN(w2.v, w2.b), OWNER_KEY });
    assert.notEqual(r.code, 0); assert.match(r.err, /fund-operator reverted/); assert.doesNotMatch(r.out, /funded/);
  } finally { await w2.close(); }
});

test("no own backend: reads work, every owner-signed command is refused before signing, nothing is submitted anywhere", async () => {
  const w = await world();
  try {
    const s = await cli(["status"], { ...OWN(w.v, null), OWNER_KEY });
    assert.equal(s.code, 0, s.err);
    for (const args of [["fund-operator", OPERATOR, "0.0004"], ["declare-payout"]]) {
      const r = await cli(args, { ...OWN(w.v, null), OWNER_KEY });
      assert.notEqual(r.code, 0, args[0]); assert.match(r.err, /backend/i, `${args[0]}: ${r.err}`);
    }
    assert.ok(![...w.v.methods(), ...w.pub.methods()].includes("eth_sendRawTransaction")); assert.equal(w.pub.calls.length, 0);
  } finally { await w.close(); }
});

test("refusals before anything: BASE_RPCS mixed with the verifier, invalid selections, a non-loopback verifier; a backend on another chain sends nothing", async () => {
  const w = await world();
  try {
    const mixed = await cli(["status"], { ...OWN(w.v, w.b), BASE_RPCS: w.pub.url, OWNER_KEY });
    assert.equal(mixed.code, 2); assert.match(mixed.err, /never mixes a provider list/);
    for (const env of [{ ENCLAVE_CHAIN_AUTHORITY: "bogus" }, { ENCLAVE_CHAIN_AUTHORITY: "verifier" }, { ENCLAVE_CHAIN_TX_BACKEND: w.b.url },
                       { ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: "http://example.com/" }]) {
      const r = await cli(["status"], { ...env, OWNER_KEY });
      assert.equal(r.code, 2, JSON.stringify(env)); assert.match(r.err, /INVALID/);
    }
    assert.equal(w.v.calls.length + w.b.calls.length + w.pub.calls.length, 0, "nothing was read or sent for a refused selection");
  } finally { await w.close(); }
  const w2 = await world({ backend: { chainId: "0x1" } });
  try {
    const r = await cli(["fund-operator", OPERATOR, "0.0004"], { ...OWN(w2.v, w2.b), OWNER_KEY });
    assert.notEqual(r.code, 0); assert.match(r.err, /another chain/);
    assert.ok(!w2.b.methods().includes("eth_sendRawTransaction"), "nothing is submitted to a backend on another chain");
  } finally { await w2.close(); }
});

test("ownership-status under the verifier: the verified host-ownership contract read at head - 2; a CONTRACT-WALLET owner is reported as the accepted owner", async () => {
  const w = await world();
  try {
    const r = await cli(["ownership-status"], { ...OWN(w.v, w.b) });
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(r.out);                                   // the WHOLE stdout is the one JSON document
    assert.match(r.err, /\[chain\] authority: local verifier/, "the authority diagnostic is on stderr"); assert.doesNotMatch(r.out, /\[chain\]/);
    assert.equal(j.owner, CONTRACT_WALLET, "the owning wallet may be a contract wallet (EIP-1271 / SessionVault): the CLI reports it exactly");
    assert.equal(j.registry, PINS.registry); assert.equal(j.ready, true); assert.equal(j.ownershipContract, OWNERSHIP);
    const reads = w.v.calls.filter((c) => c.method === "eth_call" && String(c.params[0].to).toLowerCase() === OWNERSHIP);
    assert.ok(reads.length >= 2 && reads.every((c) => BigInt(c.params[1]) === BigInt(HEAD - 2)), "both ownership reads are pinned at head - confirmations");
    assert.equal(w.b.calls.length, 0); assert.equal(w.pub.calls.length, 0);
  } finally { await w.close(); }
});

test("legacy (no authority): BASE_RPCS is used exactly as before for reads and the send; the verifier and backend are never contacted", async () => {
  const w = await world();
  try {
    const s = await cli(["status"], { BASE_RPCS: w.pub.url, OWNER_KEY });
    assert.equal(s.code, 0, s.err); assert.equal(JSON.parse(s.out).registered, true); assert.doesNotMatch(s.err, /\[chain\] authority/, "legacy prints no authority line");
    const f = await cli(["fund-operator", OPERATOR, "0.0004"], { BASE_RPCS: w.pub.url, OWNER_KEY });
    assert.equal(f.code, 0, f.err); assert.ok(w.pub.methods().includes("eth_sendRawTransaction"));
    assert.equal(w.v.calls.length + w.b.calls.length, 0);
  } finally { await w.close(); }
});
