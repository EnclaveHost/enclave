// A two-RPC fake of Base for the proposer: the ownership extension, the schema-4 registry entry, the GasPriceOracle and
// one operator account. Signed transactions are decoded, their signer recovered, and proposeOwner applied as the
// contract does (owner zero + active operator -> pendingOwner). Hooks let a test make one RPC lie, fail, race or drop.
import { encodeFunctionResult, encodeAbiParameters, decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, toHex } from "viem";
import { PRODUCTION, abi } from "../../lib/proposer.mjs";

const lc = (a) => String(a).toLowerCase();
export const OWNERSHIP_CODE = "0xfeedbeef";   // the fake's code; tests set cfg-compatible hash through codeHashOverride
export const RPC_A = "https://rpc-a.test", RPC_B = "https://rpc-b.test";
const ZERO = "0x0000000000000000000000000000000000000000";

export function fakeBase({ operator }) {
  const s = {
    head: 1000, baseFee: 5_000_000n, tip: 1_000_000n, blocks: new Map(),
    ownershipCode: "0x6080", registry: PRODUCTION.registry, registryCode: "0x6060",
    host: { endpoint: PRODUCTION.hostEndpoint, operator, active: true, payout: PRODUCTION.proposed },
    authority: { owner: ZERO, pendingOwner: ZERO, revision: 0n, policyHash: "0x" + "00".repeat(32) },
    nonce: 7, balance: 10n ** 15n, l1Fee: 30_000_000_000n, estimate: 45_000n, operatorCode: PRODUCTION.operatorDelegation, executorCode: "0x5fe1",
    pool: [], mined: new Map(), sent: [],
    hooks: {},                        // hooks[method] = (url, params, answer) => answer | throw
    onBroadcast: null,
  };
  const hashOf = (n) => keccak256(toHex(`block-${n}`));
  const block = (n) => ({ number: toHex(n), hash: hashOf(n), baseFeePerGas: toHex(s.baseFee), timestamp: toHex(1_700_000_000 + n) });
  function mine(k = 1) {
    for (let i = 0; i < k; i++) {
      s.head++;
      for (const tx of s.pool.splice(0)) {
        if (tx.nonce !== s.nonce) continue;
        s.nonce++;
        const fee = BigInt(tx.gas) * (s.baseFee + s.tip);
        s.balance -= fee;
        let ok = false;
        if (lc(tx.to) === PRODUCTION.ownership && tx.data === PRODUCTION.data && s.authority.owner === ZERO && s.host.active && lc(s.host.operator) === lc(tx.from)) {
          s.authority = { ...s.authority, pendingOwner: PRODUCTION.proposed }; ok = true;
        }
        s.mined.set(tx.hash, { ...tx, blockNumber: s.head, blockHash: hashOf(s.head), status: ok ? 1 : 0, gasUsed: 40_000n });
      }
    }
  }
  function registryEntry() {
    return encodeAbiParameters([{ type: "tuple", components: [
      { type: "string" }, { type: "string" }, { type: "bytes32" }, { type: "address" }, { type: "uint64" }, { type: "uint64" }, { type: "bool" },
      { type: "uint64" }, { type: "uint64" }, { type: "address" }, { type: "address" }, { type: "uint256" } ] }],     // + one appended field
      [[s.host.endpoint, "EnclaveHost/enclave", "0x" + "11".repeat(32), s.host.operator, 1n, 2n, s.host.active, 3n, 0n, ZERO, s.host.payout, 9n]]);
  }
  function call({ to, data, from }) {
    const t = lc(to);
    if (t === PRODUCTION.ownership) {
      const { functionName, args } = decodeFunctionData({ abi: abi.OWNERSHIP_ABI, data });
      if (functionName === "registry") return encodeFunctionResult({ abi: abi.OWNERSHIP_ABI, functionName, result: s.registry });
      if (functionName === "authority") return encodeFunctionResult({ abi: abi.OWNERSHIP_ABI, functionName,
        result: [s.authority.owner, s.authority.pendingOwner, s.authority.revision, s.authority.policyHash] });
      if (functionName === "proposeOwner") {
        if (s.authority.owner === ZERO && !(s.host.active && lc(s.host.operator) === lc(from))) throw Object.assign(new Error("execution reverted: not active operator"), { rpcError: { code: 3 } });
        if (args[1] === ZERO) throw new Error("execution reverted: owner required");
        return "0x";
      }
    }
    if (t === PRODUCTION.registry && data.startsWith("0x8eaa6ac0")) return registryEntry();
    if (t === PRODUCTION.oracle && data.startsWith("0xf1c7a58b")) return encodeAbiParameters([{ type: "uint256" }], [s.l1Fee]);
    throw new Error(`fake: no contract at ${to}`);
  }
  const atKnown = (p) => { if (p && typeof p === "object" && p.blockHash && ![...Array(40)].some((_, i) => hashOf(s.head - i) === p.blockHash)) throw new Error("fake: unknown block hash"); };
  function answer(url, method, params) {
    switch (method) {
      case "eth_chainId": return toHex(8453);
      case "eth_blockNumber": return toHex(s.head);
      case "eth_getBlockByNumber": return block(params[0] === "latest" ? s.head : Number(params[0]));
      case "eth_getCode": atKnown(params[1]);
        return lc(params[0]) === PRODUCTION.ownership ? s.ownershipCode : lc(params[0]) === PRODUCTION.registry ? s.registryCode : lc(params[0]) === lc(operator) ? s.operatorCode : lc(params[0]) === PRODUCTION.delegationTarget ? s.executorCode : "0x";
      case "eth_call": atKnown(params[1]); return call(params[0]);
      case "eth_getTransactionCount": atKnown(params[1]);
        return toHex(params[1] === "pending" ? s.nonce + s.pool.filter((x) => lc(x.from) === lc(operator)).length : s.nonce);
      case "eth_getBalance": atKnown(params[1]); return toHex(s.balance);
      case "eth_estimateGas": call(params[0]); return toHex(s.estimate);
      case "eth_maxPriorityFeePerGas": return toHex(s.tip);
      case "eth_sendRawTransaction": return null;     // handled async below
      case "eth_getTransactionReceipt": { const m = s.mined.get(params[0]); return m ? { blockNumber: toHex(m.blockNumber), blockHash: m.blockHash, status: toHex(m.status), gasUsed: toHex(m.gasUsed) } : null; }
      case "eth_getTransactionByHash": { const m = s.mined.get(params[0]) || s.pool.find((x) => x.hash === params[0]);
        return m ? { from: m.from, to: m.to, value: "0x0", input: m.data, nonce: toHex(m.nonce), blockHash: m.blockHash || null } : null; }
      default: throw new Error(`fake: ${method}`);
    }
  }
  async function rpc(url, method, params) {
    if (method === "eth_sendRawTransaction") {
      if (s.onBroadcast) await s.onBroadcast(url, params[0]);
      const raw = params[0], tx = parseTransaction(raw), from = await recoverTransactionAddress({ serializedTransaction: raw }), hash = keccak256(raw);
      s.sent.push({ url, raw, hash });
      if (Number(tx.chainId) !== 8453) throw new Error("wrong chain");
      if (s.mined.has(hash) || s.pool.some((x) => x.hash === hash)) { if (s.hooks.eth_sendRawTransaction) return s.hooks.eth_sendRawTransaction(url, params, hash); return hash; }
      if (tx.nonce !== s.nonce) throw new Error("nonce too low");
      s.pool.push({ hash, from: lc(from), to: tx.to, data: tx.data, nonce: tx.nonce, gas: tx.gas });
      return s.hooks.eth_sendRawTransaction ? s.hooks.eth_sendRawTransaction(url, params, hash) : hash;
    }
    let a = answer(url, method, params);
    if (s.hooks[method]) a = s.hooks[method](url, params, a);
    return JSON.parse(JSON.stringify(a ?? null, (k, v) => (typeof v === "bigint" ? toHex(v) : v)));
  }
  return { s, rpc, mine, RPCS: [RPC_A, RPC_B] };
}
