// In-memory Base model for tests: the metal0 registry entry, the host ownership contract (same rules as
// EnclaveHostOwnership.sol), the GasPriceOracle, accounts, a mempool, blocks with per-block state, receipts and logs.
// Served as JSON-RPC by two loopback "providers" (127.0.0.1 and 127.0.0.2) over the same chain; each provider can be
// given overrides (disagreement), a hang (timeouts) or a wrong chain id. No network but loopback.
import http from "node:http";
import { encodeFunctionResult, decodeFunctionData, encodeEventTopics, encodeAbiParameters, keccak256, toHex } from "../../enclave/node_modules/viem/_esm/index.js";
import { OWNERSHIP_ABI, REGISTRY_ABI, ORACLE_ABI } from "../stages.mjs";
import { PRODUCTION } from "../trust.mjs";

export const ZERO = "0x" + "0".repeat(40), ZERO32 = "0x" + "0".repeat(64);
export const OWN_CODE = "0x6080604052ff01", REG_CODE = "0x6080604052ff02";
const lc = (a) => String(a ?? "").toLowerCase();
const hex = (n) => "0x" + BigInt(n).toString(16);
const revert = (m) => Object.assign(Error("execution reverted: " + m), { rpc: { code: 3, message: "execution reverted: " + m } });

/** The production trust with only the code hashes and RPC/timeouts replaced (the fake's code is not the real code). */
export function fixtureTrust(urls, over = {}) {
  return Object.freeze({ ...PRODUCTION, codeHashes: Object.freeze({ ownership: keccak256(OWN_CODE), registry: keccak256(REG_CODE) }), rpcs: Object.freeze(urls),
    rpcTimeoutMs: 800, deadlineMs: 6000, ...over });
}
export const memoryJournal = (initial = { status: "ready" }) => { let v = structuredClone(initial); return { read: () => structuredClone(v), write: (x) => { v = structuredClone(x); } }; };

export class FakeBase {
  constructor(t = PRODUCTION) {
    this.t = t; this.chainId = 8453; this.baseFee = 5_000_000n; this.tip = 1_000_000n; this.l1 = 40_000_000n;
    const s = { balance: {}, nonce: {}, code: {}, authority: { owner: ZERO, pendingOwner: ZERO, revision: 0n, policyHash: ZERO32 },
      entry: { endpoint: t.hostEndpoint, repo: "enclave", measurement: ZERO32, operator: t.operator, registeredAt: 1n, lastSeen: 2n, active: true,
        cpuPricePerSec6: 0n, gpuPricePerSec6: 0n, proofKey: ZERO, payoutWallet: t.admin }, ownershipRegistry: t.registry };
    s.balance[lc(t.admin)] = 10n ** 16n; s.nonce[lc(t.admin)] = 1141n;
    s.balance[lc(t.operator)] = 376_132_087_579n; s.nonce[lc(t.operator)] = 7n;
    s.code[lc(t.ownership)] = OWN_CODE; s.code[lc(t.registry)] = REG_CODE;
    this.state = s; this.blocks = new Map(); this.head = 52_997_490n; this.pool = []; this.txs = new Map(); this.n = 0;
    this.blocks.set(this.head, this.#block(this.head, []));
    this.mine(10);
  }
  #block(number, txs) { return { number, hash: keccak256(toHex(`block-${number}-${this.n++}`)), baseFee: this.baseFee, state: structuredClone(this.state), txs }; }
  /** Edits the CURRENT state (it applies to blocks mined afterwards). */
  edit(fn) { fn(this.state); }
  stateAt(tag) {
    if (tag === "latest" || tag === "pending" || tag === undefined) return this.blocks.get(this.head).state;
    const b = this.blocks.get(BigInt(tag)); if (!b) throw Object.assign(Error("unknown block"), { rpc: { code: -32000, message: "header not found" } }); return b.state;
  }
  pendingNonce(addr) { return (this.blocks.get(this.head).state.nonce[lc(addr)] ?? 0n) + BigInt(this.pool.filter((x) => lc(x.from) === lc(addr)).length); }
  /** What a wallet does on eth_sendTransaction: accepts it into the pool and returns its hash. */
  submit(tx) {
    const from = lc(tx.from), nonce = tx.nonce !== undefined ? BigInt(tx.nonce) : this.pendingNonce(from);
    if (nonce < this.pendingNonce(from)) throw Error("nonce too low");
    const room = BigInt(tx.gas ?? 100000) * BigInt(tx.maxFeePerGas ?? this.baseFee * 2n) + BigInt(tx.value ?? 0);
    if ((this.state.balance[from] ?? 0n) < room) throw Error("insufficient funds for gas * price + value");
    const full = { from, to: tx.to ? lc(tx.to) : null, input: lc(tx.data ?? tx.input ?? "0x"), value: hex(tx.value ?? 0), nonce: hex(nonce), gas: hex(tx.gas ?? 100000),
      maxFeePerGas: hex(tx.maxFeePerGas ?? this.baseFee * 2n), maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas ?? this.tip), type: "0x2", chainId: hex(tx.chainId ?? this.chainId) };
    full.hash = keccak256(toHex(JSON.stringify(full) + "#" + this.n++));
    this.pool.push(full); this.txs.set(full.hash, { tx: full, receipt: null });
    return full.hash;
  }
  /** Executes a call against a state (mutating it). -> { output, gasUsed, logs } or throws a revert. */
  exec(s, { from, to, data = "0x", value = "0x0" }) {
    from = lc(from); to = lc(to); data = lc(data || "0x");
    const v = BigInt(value || 0);
    if (v > 0n) { if ((s.balance[from] ?? 0n) < v) throw revert("insufficient balance"); s.balance[from] -= v; s.balance[to] = (s.balance[to] ?? 0n) + v; }
    const t = this.t;
    if (to === lc(t.ownership)) {
      const { functionName: fn, args } = decodeFunctionData({ abi: OWNERSHIP_ABI, data });
      const a = s.authority, here = lc(args?.[0]) === lc(t.hostId);
      if (fn === "authority") return { output: encodeFunctionResult({ abi: OWNERSHIP_ABI, functionName: fn, result: here ? [a.owner, a.pendingOwner, a.revision, a.policyHash] : [ZERO, ZERO, 0n, ZERO32] }), gasUsed: 30000n, logs: [] };
      if (fn === "registry") return { output: encodeFunctionResult({ abi: OWNERSHIP_ABI, functionName: fn, result: s.ownershipRegistry }), gasUsed: 25000n, logs: [] };
      if (!here) throw revert("unknown host");
      if (fn === "proposeOwner") {
        if (lc(args[1]) === ZERO) throw revert("owner required");
        if (a.owner === ZERO) { if (!(s.entry.active && lc(s.entry.operator) === from)) throw revert("not active operator"); } else if (lc(a.owner) !== from) throw revert("not owner");
        a.pendingOwner = lc(args[1]);
        return { output: "0x", gasUsed: 94321n, logs: [this.#log("OwnerProposed", { hostId: t.hostId, owner: args[1] })] };
      }
      if (fn === "acceptOwner") {
        if (lc(a.pendingOwner) !== from) throw revert("not proposed owner");
        a.owner = from; a.pendingOwner = ZERO; a.policyHash = ZERO32; a.revision += 1n;
        return { output: "0x", gasUsed: 52000n, logs: [this.#log("OwnerAccepted", { hostId: t.hostId, owner: from, revision: a.revision })] };
      }
      throw revert("unsupported");
    }
    if (to === lc(t.registry)) {
      const { args } = decodeFunctionData({ abi: REGISTRY_ABI, data });
      const e = lc(args[0]) === lc(t.hostId) ? s.entry : { endpoint: "", repo: "", measurement: ZERO32, operator: ZERO, registeredAt: 0n, lastSeen: 0n, active: false, cpuPricePerSec6: 0n, gpuPricePerSec6: 0n, proofKey: ZERO, payoutWallet: ZERO };
      return { output: encodeFunctionResult({ abi: REGISTRY_ABI, functionName: "get", result: e }), gasUsed: 30000n, logs: [] };
    }
    if (to === lc(t.oracle)) { decodeFunctionData({ abi: ORACLE_ABI, data }); return { output: encodeFunctionResult({ abi: ORACLE_ABI, functionName: "getL1Fee", result: this.l1 }), gasUsed: 30000n, logs: [] }; }
    if ((s.code[to] ?? "0x") === "0x") return { output: "0x", gasUsed: 21000n, logs: [] };
    throw revert("unknown contract");
  }
  #log(name, args) {
    const ev = OWNERSHIP_ABI.find((x) => x.type === "event" && x.name === name);
    const topics = encodeEventTopics({ abi: OWNERSHIP_ABI, eventName: name, args });
    const plain = ev.inputs.filter((i) => !i.indexed);
    return { address: lc(this.t.ownership), topics, data: plain.length ? encodeAbiParameters(plain, plain.map((i) => args[i.name])) : "0x" };
  }
  /** Mines n blocks; the first includes every pool transaction in nonce order. */
  mine(n = 1) {
    for (let i = 0; i < n; i++) {
      const number = this.head + 1n, included = i === 0 ? this.pool.splice(0) : [];
      const receipts = [];
      for (const tx of included) {
        const s = this.state, before = structuredClone(s);
        if (BigInt(tx.nonce) !== (s.nonce[tx.from] ?? 0n)) { this.txs.delete(tx.hash); continue; }   // dropped
        let status = "0x1", logs = [], gasUsed = 21000n;
        try { const r = this.exec(s, { from: tx.from, to: tx.to, data: tx.input, value: tx.value }); logs = r.logs; gasUsed = r.gasUsed; }
        catch { Object.assign(s, before); status = "0x0"; }
        const price = this.baseFee + (BigInt(tx.maxPriorityFeePerGas) < BigInt(tx.maxFeePerGas) - this.baseFee ? BigInt(tx.maxPriorityFeePerGas) : BigInt(tx.maxFeePerGas) - this.baseFee);
        s.nonce[tx.from] = (s.nonce[tx.from] ?? 0n) + 1n; s.balance[tx.from] = (s.balance[tx.from] ?? 0n) - gasUsed * price;
        receipts.push({ tx, receipt: { transactionHash: tx.hash, from: tx.from, to: tx.to, status, logs, gasUsed: hex(gasUsed), contractAddress: null } });
      }
      const block = this.#block(number, included.map((x) => x.hash));
      for (const { tx, receipt } of receipts) {
        Object.assign(tx, { blockHash: block.hash, blockNumber: hex(number) });
        Object.assign(receipt, { blockHash: block.hash, blockNumber: hex(number) });
        receipt.logs = receipt.logs.map((l) => ({ ...l, blockHash: block.hash, blockNumber: hex(number), transactionHash: tx.hash }));
        this.txs.set(tx.hash, { tx, receipt });
      }
      this.blocks.set(number, block); this.head = number;
    }
  }
  /** Mines a transaction sent by someone other than the page's wallet (e.g. root's operator proposal) and n more blocks. */
  send(tx, depth = 3) { const h = this.submit(tx); this.mine(depth); return h; }

  answer(method, params) {
    switch (method) {
      case "eth_chainId": return hex(this.chainId);
      case "eth_blockNumber": return hex(this.head);
      case "eth_getBlockByNumber": { const n = params[0] === "latest" ? this.head : BigInt(params[0]); const b = this.blocks.get(n); return b ? { number: hex(n), hash: b.hash, baseFeePerGas: hex(b.baseFee), timestamp: hex(1792784000n + n) } : null; }
      case "eth_getCode": return this.stateAt(params[1]).code[lc(params[0])] ?? "0x";
      case "eth_getBalance": return hex(this.stateAt(params[1]).balance[lc(params[0])] ?? 0n);
      case "eth_getTransactionCount": return hex(params[1] === "pending" ? this.pendingNonce(params[0]) : (this.stateAt(params[1]).nonce[lc(params[0])] ?? 0n));
      case "eth_call": return this.exec(structuredClone(this.stateAt(params[1])), params[0]).output;
      case "eth_estimateGas": return hex(this.exec(structuredClone(this.stateAt(params[1])), params[0]).gasUsed);
      case "eth_maxPriorityFeePerGas": return hex(this.tip);
      case "eth_getTransactionByHash": { const x = this.txs.get(lc(params[0])); return x ? { ...x.tx, blockHash: x.tx.blockHash ?? null, blockNumber: x.tx.blockNumber ?? null } : null; }
      case "eth_getTransactionReceipt": return this.txs.get(lc(params[0]))?.receipt ?? null;
      default: throw Object.assign(Error("method not found"), { rpc: { code: -32601, message: `the method ${method} does not exist` } });
    }
  }
}

/** Two JSON-RPC providers over one FakeBase. provider.override[method] = (params, base) => result; provider.hang = true. */
export async function providers(base) {
  const make = async (host) => {
    const p = { host, override: {}, hang: false, calls: [], sockets: new Set() };
    p.server = http.createServer(async (req, res) => {
      let b = ""; for await (const c of req) b += c;
      const { id, method, params } = JSON.parse(b); p.calls.push(method);
      if (p.hang) return;   // never answers; the client's timeout must bound it
      let out;
      try { out = { jsonrpc: "2.0", id, result: p.override[method] ? await p.override[method](params, base) : base.answer(method, params) }; }
      catch (e) { out = { jsonrpc: "2.0", id, error: e.rpc ?? { code: -32603, message: e.message } }; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out));
    });
    p.server.on("connection", (s) => { p.sockets.add(s); s.on("close", () => p.sockets.delete(s)); });
    await new Promise((ok, fail) => { p.server.once("error", fail); p.server.listen(0, host, ok); });
    p.url = `http://${host}:${p.server.address().port}`;
    p.close = () => { for (const s of p.sockets) s.destroy(); return new Promise((ok) => p.server.close(ok)); };
    return p;
  };
  const list = [await make("127.0.0.1"), await make("127.0.0.2")];
  return { list, urls: list.map((p) => p.url), close: () => Promise.all(list.map((p) => p.close())) };
}
