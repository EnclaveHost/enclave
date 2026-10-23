// In-memory Base model for tests (adapted from custody-wallet-handoff-20261023@7b49cd99 test/fake-base.mjs): the original
// address book (owner-only set, AddressSet event), the SessionVault factory (isVault, implementation), SessionVaults
// (owner()), the deployments ledger (count/idAt), both custody vaults (beneficialOwnerOf with the book-factory unwrap of
// EnclaveSecretVault[V2].sol, policyOf), the GasPriceOracle, accounts, a mempool, blocks with per-block state, receipts.
// eth_call also executes viem's DEPLOYLESS Multicall3 (the exact bytecode activation.mjs sends), call by call, against
// the same contracts. Served as JSON-RPC by two loopback providers (127.0.0.1, 127.0.0.2) with per-provider overrides.
import http from "node:http";
import { encodeFunctionResult, decodeFunctionData, decodeAbiParameters, encodeEventTopics, encodeAbiParameters, keccak256, toHex, stringToHex } from "viem";
import { multicall3Bytecode, deploylessCallViaBytecodeBytecode } from "../node_modules/viem/_esm/constants/contracts.js";
import { BOOK_ABI, FACTORY_ABI, SV_ABI, VAULT_ABI, LEDGER_ABI, ORACLE_ABI, MC_ABI } from "../activation.mjs";
import { PRODUCTION } from "../trust.mjs";

export const ZERO = "0x" + "0".repeat(40), ZERO32 = "0x" + "0".repeat(64);
export const CODE = Object.freeze({ book: "0x6080ff01", factory: "0x6080ff02", implementation: "0x6080ff03", v1: "0x6080ff04", v2: "0x6080ff05", ledger: "0x6080ff06", sv: "0x6080ff07" });
const lc = (a) => String(a ?? "").toLowerCase();
const hex = (n) => "0x" + BigInt(n).toString(16);
const key = (k) => stringToHex(k, { size: 32 });
const revert = (m) => Object.assign(Error("execution reverted: " + m), { rpc: { code: 3, message: "execution reverted: " + m } });
export const EOA = { agent: "0x29479bf04ed889d46a7afb7f292b9bb26e12647c", other: "0x3977e339f1935d1a31fbbeb945c9fb36ff537f2a" };
export const POLICY_ID = "0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e";

/** The production trust with only the code hashes and RPC/timeouts replaced (the fake's code is not the real code). */
export function fixtureTrust(urls, over = {}) {
  return Object.freeze({ ...PRODUCTION, codeHashes: Object.freeze({ book: keccak256(CODE.book), factory: keccak256(CODE.factory), implementation: keccak256(CODE.implementation),
    v1: keccak256(CODE.v1), v2: keccak256(CODE.v2) }), rpcs: Object.freeze(urls), rpcTimeoutMs: 800, deadlineMs: 8000, ...over });
}
/** The Fjord GasPriceOracle.getL1FeeUpperBound shape: size + 68 signature bytes, worst-case fastlz (+size/255 + 16). */
export const l1UpperBound = (unsignedSize, perByte) => { const n = BigInt(unsignedSize) + 68n; return (n + n / 255n + 16n) * perByte; };
export const memoryJournal = (initial = { status: "ready" }) => { let v = structuredClone(initial); return { read: () => structuredClone(v), write: (x) => { v = structuredClone(x); } }; };

export class FakeBase {
  constructor(t = PRODUCTION) {
    this.t = t; this.chainId = 8453; this.baseFee = 5_000_000n; this.tip = 1_000_000n; this.l1PerByte = 200_000n; this.setGas = 47_000n;
    const ids = [POLICY_ID, ...t.reviewedVaultHeld, ...Array.from({ length: 12 }, (_, i) => keccak256(toHex(`deployment-${i}`)))];
    const owner = {};
    owner[POLICY_ID] = EOA.agent; for (const id of t.reviewedVaultHeld) owner[id] = t.sessionVault;
    ids.slice(5).forEach((id, i) => { owner[id] = i % 2 ? EOA.other : t.admin; });
    const s = { balance: {}, nonce: {}, code: {},
      book: { owner: t.admin, pendingOwner: ZERO, entries: { [key("deployments")]: t.ledger } },
      implementation: t.implementation, vaults: { [lc(t.sessionVault)]: t.admin },     // factory vaults -> owner()
      ledger: { ids, owner },
      policies: { [lc(t.vaults.v1)]: { [POLICY_ID]: { owner: EOA.agent, policyRev: 1n } }, [lc(t.vaults.v2)]: { [POLICY_ID]: { owner: EOA.agent, policyRev: 2n } } } };
    s.balance[lc(t.admin)] = 10n ** 16n; s.nonce[lc(t.admin)] = 2210n;
    for (const [k, a] of [["book", t.book], ["factory", t.factory], ["implementation", t.implementation], ["v1", t.vaults.v1], ["v2", t.vaults.v2], ["ledger", t.ledger], ["sv", t.sessionVault]]) s.code[lc(a)] = CODE[k];
    this.state = s; this.blocks = new Map(); this.head = 52_999_000n; this.pool = []; this.txs = new Map(); this.n = 0;
    this.blocks.set(this.head, this.#block(this.head, []));
    this.mine(10);
  }
  #block(number, txs) { return { number, hash: keccak256(toHex(`block-${number}-${this.n++}`)), baseFee: this.baseFee, state: structuredClone(this.state), txs }; }
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
    const full = { from, to: tx.to ? lc(tx.to) : null, input: lc(tx.data ?? tx.input ?? "0x"), value: hex(tx.value ?? 0), nonce: hex(nonce), gas: hex(tx.gas ?? 100000),
      maxFeePerGas: hex(tx.maxFeePerGas ?? this.baseFee * 2n), maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas ?? this.tip), type: "0x2", chainId: hex(tx.chainId ?? this.chainId), accessList: tx.accessList ?? [] };
    full.hash = keccak256(toHex(JSON.stringify(full) + "#" + this.n++));
    this.pool.push(full); this.txs.set(full.hash, { tx: full, receipt: null });
    return full.hash;
  }
  /** Executes a call against a state (mutating it) -> { output, gasUsed, logs } or throws a revert. */
  exec(s, { from, to, data = "0x" }) {
    from = lc(from); data = lc(data || "0x");
    if (!to) return this.#deployless(s, data);
    to = lc(to);
    const t = this.t, code = s.code[to] ?? "0x";
    const unwrap = (o) => { const f = lc(s.book.entries[key(t.key)] ?? ZERO); return f === lc(t.factory) && (s.code[lc(o)] ?? "0x") !== "0x" && s.vaults[lc(o)] ? s.vaults[lc(o)] : o; };
    if (code === CODE.book) {
      const { functionName: fn, args } = decodeFunctionData({ abi: BOOK_ABI, data });
      if (fn === "owner") return out(BOOK_ABI, fn, s.book.owner); if (fn === "pendingOwner") return out(BOOK_ABI, fn, s.book.pendingOwner);
      if (fn === "addr") return out(BOOK_ABI, fn, s.book.entries[lc(args[0])] ?? ZERO);
      if (fn === "set") {
        if (from !== lc(s.book.owner)) throw revert("!owner");
        s.book.entries[lc(args[0])] = lc(args[1]);
        return { output: "0x", gasUsed: this.setGas, logs: [this.#log("AddressSet", { key: args[0], value: args[1] })] };
      }
    }
    if (code === CODE.factory) {
      const { functionName: fn, args } = decodeFunctionData({ abi: FACTORY_ABI, data });
      if (fn === "implementation") return out(FACTORY_ABI, fn, s.implementation);
      if (fn === "isVault") return out(FACTORY_ABI, fn, !!s.vaults[lc(args[0])]);
    }
    if (code === CODE.sv) { decodeFunctionData({ abi: SV_ABI, data }); return out(SV_ABI, "owner", s.vaults[to] ?? ZERO); }
    if (code === CODE.ledger) {
      const { functionName: fn, args } = decodeFunctionData({ abi: LEDGER_ABI, data });
      if (fn === "count") return out(LEDGER_ABI, fn, BigInt(s.ledger.ids.length));
      if (fn === "idAt") { const id = s.ledger.ids[Number(args[0])]; if (!id) throw revert("index"); return out(LEDGER_ABI, fn, id); }
    }
    if (code === CODE.v1 || code === CODE.v2) {
      const { functionName: fn, args } = decodeFunctionData({ abi: VAULT_ABI, data });
      const id = lc(args[0]);
      if (fn === "beneficialOwnerOf") return out(VAULT_ABI, fn, unwrap(s.ledger.owner[id] ?? ZERO));
      if (fn === "policyOf") { const p = s.policies[to]?.[id]; return out(VAULT_ABI, fn, [p?.owner ?? ZERO, p?.policyRev ?? 0n, 0n, ZERO32, false, "0x"]); }
    }
    if (to === lc(t.oracle)) { const { args } = decodeFunctionData({ abi: ORACLE_ABI, data }); return out(ORACLE_ABI, "getL1FeeUpperBound", l1UpperBound(args[0], this.l1PerByte)); }
    if (code === "0x") return { output: "0x", gasUsed: 21000n, logs: [] };
    throw revert("unknown contract");
    function out(abi, functionName, result) { return { output: encodeFunctionResult({ abi, functionName, result }), gasUsed: 30000n, logs: [] }; }
  }
  /** viem's deployless Multicall3: only the exact pinned bytecode is executed. */
  #deployless(s, data) {
    if (!data.startsWith(lc(deploylessCallViaBytecodeBytecode))) throw revert("unsupported contract creation");
    const [code, inner] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], "0x" + data.slice(deploylessCallViaBytecodeBytecode.length));
    if (lc(code) !== lc(multicall3Bytecode)) throw revert("unexpected deployless code");
    const { args: [calls] } = decodeFunctionData({ abi: MC_ABI, data: inner });
    const results = calls.map((c) => { try { return { success: true, returnData: this.exec(structuredClone(s), { from: ZERO, to: c.target, data: c.callData }).output }; } catch { return { success: false, returnData: "0x" }; } });
    return { output: encodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", result: results }), gasUsed: 1_000_000n, logs: [] };
  }
  #log(name, args) {
    const ev = BOOK_ABI.find((x) => x.type === "event" && x.name === name);
    const topics = encodeEventTopics({ abi: BOOK_ABI, eventName: name, args });
    const plain = ev.inputs.filter((i) => !i.indexed);
    return { address: lc(this.t.book), topics, data: plain.length ? encodeAbiParameters(plain, plain.map((i) => args[i.name])) : "0x" };
  }
  /** Mines n blocks; the first includes every pool transaction in nonce order. */
  mine(n = 1) {
    for (let i = 0; i < n; i++) {
      const number = this.head + 1n, included = i === 0 ? this.pool.splice(0) : [];
      const receipts = [];
      for (const tx of included) {
        const s = this.state, before = structuredClone(s);
        if (BigInt(tx.nonce) !== (s.nonce[tx.from] ?? 0n)) { this.txs.delete(tx.hash); continue; }
        let status = "0x1", logs = [], gasUsed = 21000n;
        try { const r = this.exec(s, { from: tx.from, to: tx.to, data: tx.input }); logs = r.logs; gasUsed = r.gasUsed; }
        catch { for (const k of Object.keys(s)) s[k] = before[k]; status = "0x0"; }
        s.nonce[tx.from] = (s.nonce[tx.from] ?? 0n) + 1n; s.balance[tx.from] = (s.balance[tx.from] ?? 0n) - gasUsed * (this.baseFee + 1n);
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
  answer(method, params) {
    switch (method) {
      case "eth_chainId": return hex(this.chainId);
      case "eth_blockNumber": return hex(this.head);
      case "eth_getBlockByNumber": { const n = params[0] === "latest" ? this.head : BigInt(params[0]); const b = this.blocks.get(n); return b ? { number: hex(n), hash: b.hash, baseFeePerGas: hex(b.baseFee), timestamp: hex(1792787000n + n) } : null; }
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
      if (p.hang) return;
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
