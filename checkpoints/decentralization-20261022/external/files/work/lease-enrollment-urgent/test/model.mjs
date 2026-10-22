// A small in-memory Base model for the enrollment chain checks: the reserve/ledger/vault/book/executor calls the queue
// makes, eth_simulateV1 over a state copy, and landed transactions with receipts and logs. Code hashes are fixture pins.
import { decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, keccak256, parseAbi } from "../../enclave/node_modules/viem/_esm/index.js";
import { EXECUTOR_ABI } from "../../lease-gas-wallet-signing/stages.mjs";
import { VAULT_ABI, budgetKey } from "../plan.mjs";
import { ENROLLMENT } from "../trust.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a) => String(a).toLowerCase();
const BOOK_ABI = parseAbi(["function owner() view returns (address)"]);
const FACTORY_ABI = parseAbi(["function isVault(address) view returns (bool)"]);
const LEDGER_ABI = parseAbi(["function get(bytes32) view returns ((bytes32 id, address owner, string appRef, string ports, string configCid, uint16 gpuMilli, uint16 cpuMilli, uint32 appPort, bool isPublic, bool active, uint64 createdAt, uint256 rate, uint256 balance6, uint256 spent6, bytes32 runner, address runnerOperator, uint64 leaseUntil))"]);
const ORACLE_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
const CODE = { ledger: "0x6001", registry: "0x6002", reserve: "0x6003", executor: "0x6004", factory: "0x6005", vault: "0x6006" };
export const TRUST = Object.freeze({ ...ENROLLMENT, codeHashes: { ledger: keccak256(CODE.ledger), registry: keccak256(CODE.registry) },
  reserveRuntimeHash: keccak256(CODE.reserve), executorRuntimeHash: keccak256(CODE.executor), vaultFactoryCodeHash: keccak256(CODE.factory) });

const zeroOf = (t) => (t === "bool" ? false : t === "address" ? ZERO : t.startsWith("bytes") ? "0x" + "0".repeat(64) : t === "string" ? "" : 0n);
export function createModel(abi) {
  const t = TRUST, reserveOut = abi.find((x) => x.name === "reserveOf").outputs[0].components;
  const s = { head: 1000n, nonce: 7, pending: 7, balance: 10n ** 18n, adminCode: "0x", owner: lc(t.admin), executor: t.executor, dch: t.delegationCodeHash, paused: false,
    vaultOwner: lc(t.admin), isVault: true, ledgerOwner: {}, blocked: {}, res: {}, claim: {}, bal: {}, codes: {}, txs: {}, tip: 1_000_000n, baseFee: 5_000_000n };
  Object.assign(s.codes, { [t.ledger.toLowerCase()]: CODE.ledger, [t.registry.toLowerCase()]: CODE.registry, [t.reserve]: CODE.reserve, [t.executor]: CODE.executor, [t.vaultFactory]: CODE.factory, [t.dnsVault]: CODE.vault });
  for (const [id, who] of t.apps) s.ledgerOwner[id] = who === "admin" ? lc(t.admin) : t.dnsVault;
  const reserveOf = (st, id, o) => (st.res[budgetKey(id, o)] ??= Object.fromEntries(reserveOut.map((c) => [c.name, zeroOf(c.type)])));
  const log = (eventName, args) => { const ev = abi.find((x) => x.type === "event" && x.name === eventName), non = ev.inputs.filter((i) => !i.indexed);
    return { address: t.reserve, topics: encodeEventTopics({ abi, eventName, args }), data: encodeAbiParameters(non, non.map((i) => args[i.name])) }; };
  /** Execute one call against state `st` -> { returnData, logs, gasUsed } or throws (revert). */
  function exec(st, from, to, data, value = 0n) {
    to = lc(to); from = lc(from); value = BigInt(value);
    const out = (a, functionName, result) => ({ returnData: encodeFunctionResult({ abi: a, functionName, result }), logs: [], gasUsed: 30000n });
    if (to === lc(t.book)) return out(BOOK_ABI, "owner", st.owner);
    if (to === lc(t.oracle)) return out(ORACLE_ABI, "getL1Fee", 1000n);
    if (to === t.executor) return out(EXECUTOR_ABI, "reserve", t.reserve);
    if (to === lc(t.ledger)) { const [id] = decodeFunctionData({ abi: LEDGER_ABI, data }).args;
      return out(LEDGER_ABI, "get", { id, owner: st.ledgerOwner[id] ?? ZERO, appRef: "", ports: "", configCid: "", gpuMilli: 0, cpuMilli: 0, appPort: 0, isPublic: false, active: true, createdAt: 0n, rate: 0n, balance6: 0n, spent6: 0n, runner: "0x" + "0".repeat(64), runnerOperator: ZERO, leaseUntil: 0n }); }
    if (to === t.vaultFactory) return out(FACTORY_ABI, "isVault", st.isVault);
    if (to === t.dnsVault) { const d = decodeFunctionData({ abi: VAULT_ABI, data });
      if (d.functionName === "owner") return out(VAULT_ABI, "owner", st.vaultOwner); if (d.functionName === "factory") return out(VAULT_ABI, "factory", t.vaultFactory);
      if (from !== st.vaultOwner) throw Error("NotOwner"); const r = exec(st, t.dnsVault, d.args[0], d.args[1]); return { ...r, gasUsed: r.gasUsed + 20000n }; }
    if (to === t.reserve) {
      const { functionName: f, args } = decodeFunctionData({ abi, data });
      const simple = { owner: st.owner, pendingOwner: ZERO, ledger: t.ledger, registry: t.registry, l1Oracle: t.oracle, executor: st.executor, delegationCodeHash: st.dch, paused: st.paused };
      if (f in simple) return out(abi, f, simple[f]);
      if (f === "blockedDeployment") return out(abi, f, !!st.blocked[args[0]]);
      if (f === "reserveOf") return out(abi, f, reserveOf(st, args[0], lc(args[1])));
      if (f === "claimantAllowed") return out(abi, f, !!st.claim[args[0] + lc(args[1])]);
      const owner = st.ledgerOwner[args[0]];
      if (f === "deposit") { if (value === 0n) throw Error("amount"); reserveOf(st, args[0], owner).balanceWei += value; return { returnData: "0x", logs: [log("Deposited", { id: args[0], owner, from, amountWei: value })], gasUsed: 60000n }; }
      if (from !== owner) throw Error("!owner");
      if (f === "configure") { Object.assign(reserveOf(st, args[0], owner), args[1], { lastClaimAt: 1n }); return { returnData: "0x", logs: [log("Configured", { id: args[0], owner, policy: args[1] })], gasUsed: 110000n }; }
      if (f === "setClaimant") { st.claim[budgetKey(args[0], owner) + lc(args[1])] = args[2]; return { returnData: "0x", logs: [log("ClaimantSet", { id: args[0], owner, operator: args[1], allowed: args[2] })], gasUsed: 50000n }; }
      throw Error("unmodelled reserve call " + f);
    }
    if (!st.codes[to]) { st.bal[to] = (st.bal[to] ?? 0n) + value; return { returnData: "0x", logs: [], gasUsed: 21000n }; }
    throw Error("unmodelled call to " + to);
  }
  /** Two RPC clients over the same model; `tweak[i](method, args, result)` may alter what client i reports. */
  function clients(tweak = []) {
    return ["https://a.example", "https://b.example"].map((url, i) => {
      const f = tweak[i] || ((_m, _a, r) => r), w = (m, fn) => async (a = {}) => f(m, a, await fn(a));
      return { transport: { url },
        getBlockNumber: w("getBlockNumber", async () => s.head), getChainId: w("getChainId", async () => 8453),
        getBlock: w("getBlock", async ({ blockNumber }) => ({ hash: "0x" + BigInt(blockNumber).toString(16).padStart(64, "0"), baseFeePerGas: s.baseFee })),
        getCode: w("getCode", async ({ address }) => (lc(address) === lc(t.admin) ? s.adminCode : s.codes[lc(address)])),
        getTransactionCount: w("getTransactionCount", async ({ blockTag }) => (blockTag === "pending" ? s.pending : s.nonce)),
        getBalance: w("getBalance", async ({ address }) => (lc(address) === lc(t.admin) ? s.balance : s.bal[lc(address)] ?? 0n)),
        estimateMaxPriorityFeePerGas: w("tip", async () => s.tip),
        readContract: w("readContract", async ({ address, abi: a, functionName, args }) => {
          const { encodeFunctionData, decodeFunctionResult } = await import("../../enclave/node_modules/viem/_esm/index.js");
          const r = exec(structuredClone(s), t.admin, address, encodeFunctionData({ abi: a, functionName, args }));
          return decodeFunctionResult({ abi: a, functionName, data: r.returnData }); }),
        request: w("request", async ({ method, params }) => {
          if (method !== "eth_simulateV1") throw Error("unexpected " + method);
          const st = structuredClone(s);
          return [{ calls: params[0].blockStateCalls[0].calls.map((c) => { try { const r = exec(st, c.from, c.to, c.data, c.value); return { status: "0x1", returnData: r.returnData, gasUsed: "0x" + r.gasUsed.toString(16) }; }
            catch (e) { return { status: "0x0", returnData: "0x", gasUsed: "0x0", error: e.message }; } }) }];
        }),
        getTransaction: w("getTransaction", async ({ hash }) => { if (!s.txs[hash]) throw Error("transaction not found"); return s.txs[hash].tx; }),
        getTransactionReceipt: w("getTransactionReceipt", async ({ hash }) => { if (!s.txs[hash]) throw Error("receipt not found"); return s.txs[hash].receipt; }),
      };
    });
  }
  /** Mine a wallet transaction for `request` (fields overridable), as Base would; returns its hash. */
  function land(request, { tx: over = {}, revert = false, logs } = {}) {
    const w = request.transaction, hash = "0x" + (Object.keys(s.txs).length + 1).toString(16).padStart(64, "a");
    const tx = { hash, from: lc(w.from), to: lc(w.to), chainId: 8453, type: "eip1559", nonce: Number(BigInt(w.nonce)), input: w.data, value: BigInt(w.value), gas: BigInt(w.gas),
      maxFeePerGas: BigInt(w.maxFeePerGas), maxPriorityFeePerGas: BigInt(w.maxPriorityFeePerGas), ...over };
    let r = { logs: [], gasUsed: 21000n };
    if (!revert) { try { r = exec(s, tx.from, tx.to, tx.input, tx.value); } catch { revert = true; } }
    s.nonce += 1; s.pending = s.nonce;
    const blockNumber = s.head; s.head += 1n;
    s.txs[hash] = { tx, receipt: { transactionHash: hash, from: tx.from, to: tx.to, status: revert ? "reverted" : "success", logs: logs ?? (revert ? [] : r.logs), gasUsed: r.gasUsed,
      blockNumber, blockHash: "0x" + blockNumber.toString(16).padStart(64, "0") } };
    return hash;
  }
  return { state: s, clients, land, exec };
}
