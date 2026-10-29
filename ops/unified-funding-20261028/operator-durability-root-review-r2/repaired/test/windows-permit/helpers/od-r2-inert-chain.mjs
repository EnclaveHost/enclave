// durability r2 TEST HELPER (AUTHORED, NOT RUN). An in-memory Base-like JSON-RPC peer set (three distinct TEST hosts) and two
// in-memory lease relays behind ONE fetch dispatcher, used to drive the SHIPPED control/windows/node/lease-gas-runtime.bundle.mjs
// client through the actual chain.mjs. It supplies EXTERNAL inputs only: RPC answers, relay HTTP answers and the reviewed deployment
// record file (+ its digest). It never replaces, wraps or hooks the bundle, configuredLeaseSender, createLeaseClient or chain.mjs.
// NO LIVE NETWORK: every URL outside the reserved TEST namespace (*.od-r2.test) is refused, by default and by construction.
// No signature is verified and nothing is signed here (the inert TEST account lives in the test file).
// PROVENANCE: the ABI fragments and answer shapes are transcribed (not imported) from the readonly reference
// readonly-reference/sponsored-runtime/source/client/lease-executor-client.mjs (RESERVE_ABI, EXECUTOR_ABI, LEDGER_ABI, policy, quote,
// currentFees, verifyLeaseReceipt, createLeaseClient run/settledAuthority/findLanded/resolveSigned, boundedFetchJson) and
// client/lease-executor-authority.mjs (leaseRpcSet, verifiedLeaseAuthority): reference bundle sha256 21fece1f..., NOT the shipped
// 159108d1... bundle. Matching shapes are a structural reference, not proof of version equivalence: a difference shows up as a FIXTURE
// failure for root to adapt HERE, never in the bundle. The chain answers CURRENT state for every block tag/hash (no history model).
// Runtime dependency: the npm package "viem" (candidate package.json/lock) for ABI encoding and keccak256 in this helper only.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { keccak256, getAddress, toHex, encodeFunctionResult, decodeFunctionData, encodeFunctionData, encodeAbiParameters, encodeEventTopics } from "viem";

const LEASE_TUPLE = { type: "tuple", name: "l", components: [{ name: "id", type: "bytes32" }, { name: "kind", type: "uint8" },
  { name: "enclaveId", type: "bytes32" }, { name: "nonce", type: "uint64" }, { name: "deadline", type: "uint64" },
  { name: "payee", type: "address" }, { name: "maxChargeWei", type: "uint256" }] };
export const EXECUTOR_ABI = [
  { type: "function", name: "lease", stateMutability: "nonpayable", inputs: [LEASE_TUPLE, { name: "signature", type: "bytes" }], outputs: [] },
  { type: "function", name: "nonceOf", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "reserve", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const RESERVE_TUPLE = [{ name: "balanceWei", type: "uint128" }, { name: "maxPerOpWei", type: "uint64" }, { name: "epochCapWei", type: "uint64" },
  { name: "enabled", type: "bool" }, { name: "claimPolicy", type: "uint8" }, { name: "sponsorRelease", type: "bool" }, { name: "renewWindow", type: "uint32" },
  { name: "minExtension", type: "uint32" }, { name: "claimCooldown", type: "uint32" }, { name: "epochSec", type: "uint32" }, { name: "maxGasPrice", type: "uint64" },
  { name: "maxClaimsPerEpoch", type: "uint8" }, { name: "epochIndex", type: "uint32" }, { name: "epochSpentWei", type: "uint96" }, { name: "epochClaims", type: "uint8" },
  { name: "lastClaimAt", type: "uint64" }, { name: "lastClaimOperator", type: "address" }];
export const RESERVE_ABI = [
  { type: "function", name: "statusOf", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }, { type: "address" }],
    outputs: [{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "reserveOf", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "tuple", components: RESERVE_TUPLE }] },
  { type: "function", name: "executor", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "ledger", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "registry", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "delegationCodeHash", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "limits", stateMutability: "view", inputs: [], outputs: [{ name: "maxGasPriceCeiling", type: "uint64" },
    { name: "overheadClaimGas", type: "uint32" }, { name: "overheadRenewGas", type: "uint32" }, { name: "overheadReleaseGas", type: "uint32" },
    { name: "minClaimInterval", type: "uint32" }, { name: "l1Bps", type: "uint16" }] },
  { type: "function", name: "l1Oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "event", name: "LeaseGasPaid", inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "owner", type: "address", indexed: true },
    { name: "operator", type: "address", indexed: true }, { name: "payee", type: "address" }, { name: "kind", type: "uint8" }, { name: "gas", type: "uint256" },
    { name: "gasPrice", type: "uint256" }, { name: "l1FeeWei", type: "uint256" }, { name: "chargedWei", type: "uint256" }] },
];
const LEDGER_ABI = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" },
  { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
  { name: "isPublic", type: "bool" }, { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" },
  { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" }, { name: "runnerOperator", type: "address" },
  { name: "leaseUntil", type: "uint64" }] }] }];
const ZERO = "0x" + "00".repeat(20), ZERO32 = "0x" + "00".repeat(32);
const lc = (s) => String(s).toLowerCase();
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * createInertChain({ dir, operator, owner }) -> { S, A, env, fetch, reveal }
 *   env: the ENCLAVE_LEASE_GAS_* settings for chain.mjs (record file written in `dir`, its digest, 3 TEST RPCs, 2 TEST relays)
 *   S.accountNonce: the operator ACCOUNT nonce (mined); S.delegated; S.relayMode[origin] = "land" | "refuse" | "land-silent"
 *   S.gets/S.posts: every relay GET /v1/info and POST /v1/lease (origin); S.onPost(origin, body): called when a POST arrives
 *   reveal(): applies the landings staged by "land-silent" relays (an answer lost, its transaction included later)
 */
export function createInertChain({ dir, operator, owner }) {
  const A = { reserve: getAddress("0x" + "a1".repeat(20)), executor: getAddress("0x" + "a2".repeat(20)), ledger: getAddress("0x" + "a3".repeat(20)), registry: getAddress("0x" + "a4".repeat(20)) };
  const code = { reserve: "0x600160015500", executor: "0x600260025500" };
  const record = { format: "enclave-lease-gas-deployment/v1", chainId: 8453, ...A, reserveCodeHash: keccak256(code.reserve), executorCodeHash: keccak256(code.executor) };
  const bytes = Buffer.from(JSON.stringify(record));
  const file = path.join(dir, "lease-gas-deployment.json"); fs.writeFileSync(file, bytes);
  const relays = { "https://relay-a.od-r2.test": getAddress("0x" + "b1".repeat(20)), "https://relay-b.od-r2.test": getAddress("0x" + "b2".repeat(20)) };
  const rpcs = ["https://rpc-a.od-r2.test", "https://rpc-b.od-r2.test", "https://rpc-c.od-r2.test"];
  const S = { head: 100, times: new Map(), accountNonce: 5, delegated: false, leaseNonce: new Map(), rows: new Map(), txs: new Map(), logs: [], staged: [],
    relayMode: {}, gets: [], posts: [], onPost: null, methods: [] };
  const env = { ENCLAVE_LEASE_GAS_FILE: file, ENCLAVE_LEASE_GAS_DIGEST: "sha256:" + sha256(bytes), ENCLAVE_LEASE_GAS_RPCS: rpcs.join(","),
    ENCLAVE_LEASE_GAS_RELAYS: Object.keys(relays).join(",") };
  const OP = getAddress(operator), OWNER = getAddress(owner);
  const blockTime = (n) => { if (!S.times.has(n)) S.times.set(n, Math.floor(Date.now() / 1000)); return S.times.get(n); };
  const blockHash = (n) => "0x" + n.toString(16).padStart(64, "0");
  const block = (n) => ({ number: toHex(n), hash: blockHash(n), parentHash: blockHash(n - 1), timestamp: toHex(blockTime(n)), baseFeePerGas: toHex(1_000_000_000n),
    gasLimit: toHex(30_000_000n), gasUsed: "0x0", miner: ZERO, nonce: "0x0000000000000000", transactions: [], uncles: [], difficulty: "0x0", extraData: "0x",
    logsBloom: "0x" + "00".repeat(256), receiptsRoot: ZERO32, stateRoot: ZERO32, transactionsRoot: ZERO32, sha3Uncles: ZERO32, size: "0x0", totalDifficulty: "0x0", mixHash: ZERO32 });
  const row = (id) => S.rows.get(lc(id)) ?? { id, owner: OWNER, appRef: "", ports: "", configCid: "", gpuMilli: 0, cpuMilli: 0, appPort: 0, isPublic: true, active: true,
    createdAt: 1n, rate: 0n, balance6: 0n, spent6: 0n, runner: ZERO32, runnerOperator: OP, leaseUntil: 0n };
  const designator = () => "0xef0100" + lc(A.executor).slice(2);
  function reserveAnswer(fn) {
    switch (fn) {
      case "statusOf": return [0, 10n ** 18n, 10n ** 18n, 10n ** 17n];   // "Ready"
      case "reserveOf": return { balanceWei: 10n ** 18n, maxPerOpWei: 10n ** 17n, epochCapWei: 10n ** 18n, enabled: true, claimPolicy: 1, sponsorRelease: true,
        renewWindow: 3600, minExtension: 60, claimCooldown: 0, epochSec: 86400, maxGasPrice: 10n ** 11n, maxClaimsPerEpoch: 10, epochIndex: 0, epochSpentWei: 0n,
        epochClaims: 0, lastClaimAt: 0n, lastClaimOperator: ZERO };
      case "executor": return A.executor;
      case "ledger": return A.ledger;
      case "registry": return A.registry;
      case "delegationCodeHash": return keccak256(designator());
      case "limits": return [10n ** 11n, 0, 0, 0, 0, 0];
      case "l1Oracle": return ZERO;
      default: throw Error(`TEST reserve has no ${fn}`);
    }
  }
  function call({ to, data }) {
    const t = getAddress(to);
    const answer = (abi, f) => { const { functionName, args } = decodeFunctionData({ abi, data }); return encodeFunctionResult({ abi, functionName, result: f(functionName, args ?? []) }); };
    if (t === A.reserve) return answer(RESERVE_ABI, reserveAnswer);
    if (t === A.executor) return answer(EXECUTOR_ABI, (fn) => { if (fn === "reserve") return A.reserve; throw Error(`TEST executor has no ${fn}`); });
    if (t === A.ledger) return answer(LEDGER_ABI, (_fn, [id]) => row(id));
    if (t === OP) return answer(EXECUTOR_ABI, (fn, [id]) => { if (fn === "nonceOf") return BigInt(S.leaseNonce.get(lc(id)) ?? 0); throw Error(`TEST operator has no ${fn}`); });
    throw Error(`TEST: no contract at ${to}`);
  }
  function rpc(method, params) {
    switch (method) {
      case "eth_chainId": return "0x2105";
      case "eth_blockNumber": return toHex(S.head);
      case "eth_getBlockByNumber": { const n = params[0] === "latest" || params[0] === "pending" ? S.head : Number(BigInt(params[0])); return n > S.head ? null : block(n); }
      case "eth_getCode": { const a = getAddress(params[0]); return a === A.reserve ? code.reserve : a === A.executor ? code.executor : a === OP && S.delegated ? designator() : "0x"; }
      case "eth_getTransactionCount": return toHex(getAddress(params[0]) === OP ? S.accountNonce : 0);
      case "eth_call": return call(params[0]);
      case "eth_getLogs": {
        const f = params[0] ?? {}, topics = f.topics ?? [];
        return S.logs.filter((g) => (!f.address || lc(g.address) === lc(f.address)) && topics.every((t, i) => t === null || t === undefined || (Array.isArray(t) ? t.map(lc).includes(lc(g.topics[i])) : lc(t) === lc(g.topics[i]))));
      }
      case "eth_getTransactionByHash": return S.txs.get(lc(params[0]))?.tx ?? null;
      case "eth_getTransactionReceipt": return S.txs.get(lc(params[0]))?.receipt ?? null;
      default: throw Error(`TEST RPC has no ${method}`);
    }
  }
  /** a relay's transaction carrying exactly the POSTed lease (and its authorization), included in a new TEST block */
  function land(body, payee) {
    const l = body.lease;
    const lease = { id: lc(l.id), kind: Number(l.kind), enclaveId: lc(l.enclaveId), nonce: BigInt(l.nonce), deadline: BigInt(l.deadline), payee: getAddress(l.payee), maxChargeWei: BigInt(l.maxChargeWei) };
    const input = encodeFunctionData({ abi: EXECUTOR_ABI, functionName: "lease", args: [lease, body.signature] });
    const n = ++S.head, bh = blockHash(n), hash = "0x" + sha256(`${n}:${input}`);
    const log = { address: lc(A.reserve), topics: encodeEventTopics({ abi: RESERVE_ABI, eventName: "LeaseGasPaid", args: { id: lease.id, owner: OWNER, operator: OP } }),
      data: encodeAbiParameters([{ type: "address" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [payee, lease.kind, 200_000n, 1_000_000_000n, 0n, 1n]),
      blockNumber: toHex(n), blockHash: bh, transactionHash: hash, transactionIndex: "0x0", logIndex: "0x0", removed: false };
    const tx = { hash, blockHash: bh, blockNumber: toHex(n), from: lc(payee), to: lc(OP), chainId: "0x2105", value: "0x0", input, nonce: "0x0", gas: toHex(400_000n), type: "0x2",
      maxFeePerGas: toHex(2_000_000_000n), maxPriorityFeePerGas: toHex(1_000_000n), gasPrice: toHex(1_000_000_000n), accessList: [], transactionIndex: "0x0",
      v: "0x0", r: "0x" + "01".repeat(32), s: "0x" + "02".repeat(32), yParity: "0x0" };
    const receipt = { transactionHash: hash, blockHash: bh, blockNumber: toHex(n), status: "0x1", logs: [log], from: lc(payee), to: lc(OP), contractAddress: null,
      cumulativeGasUsed: toHex(200_000n), gasUsed: toHex(200_000n), effectiveGasPrice: toHex(1_000_000_000n), logsBloom: "0x" + "00".repeat(256), transactionIndex: "0x0", type: "0x2" };
    S.txs.set(hash, { tx, receipt }); S.logs.push(log);
    if (body.authorization && !S.delegated) S.accountNonce++;   // the EIP-7702 authorization consumed the operator's ACCOUNT nonce
    S.delegated = true;
    S.leaseNonce.set(lease.id, Number(lease.nonce) + 1);   // the executor's LEASE nonce lane (a different counter)
    const r = row(lease.id);
    S.rows.set(lease.id, { ...r, runner: lease.kind === 1 ? lease.enclaveId : r.runner, runnerOperator: lease.kind === 3 ? ZERO : OP });
    return hash;
  }
  async function relay(origin, u, init) {
    const method = String(init?.method || "GET").toUpperCase();
    if (u.pathname === "/v1/info" && method === "GET") { S.gets.push(origin); return json(200, { chainId: 8453, reserve: A.reserve, executor: A.executor, payee: relays[origin] }); }
    if (u.pathname === "/v1/lease" && method === "POST") {
      S.posts.push(origin);
      const body = JSON.parse(String(init.body));
      S.onPost?.(origin, body);
      const mode = S.relayMode[origin] ?? "land";
      if (mode === "refuse") return json(502, { error: "TEST relay refused" });
      if (mode === "land-silent") { S.staged.push(() => land(body, relays[origin])); return json(502, { error: "TEST answer lost" }); }
      return json(200, { hash: land(body, relays[origin]) });
    }
    return json(404, { error: "TEST not found" });
  }
  async function fetchTEST(input, init = {}) {
    const u = new URL(typeof input === "string" ? input : input?.url ?? String(input));
    if (!u.hostname.endsWith(".od-r2.test")) throw Error(`TEST: live network refused (${u.protocol}//${u.hostname})`);
    if (rpcs.includes(u.origin)) {
      const req = JSON.parse(String(init.body));
      const one = (q) => { S.methods.push(q.method); try { return { jsonrpc: "2.0", id: q.id, result: rpc(q.method, q.params ?? []) }; } catch (e) { return { jsonrpc: "2.0", id: q.id, error: { code: -32000, message: e.message } }; } };
      return json(200, Array.isArray(req) ? req.map(one) : one(req));
    }
    if (Object.hasOwn(relays, u.origin)) return relay(u.origin, u, init);
    throw Error(`TEST: unknown TEST host ${u.hostname}`);
  }
  return { S, A, env, relays, fetch: fetchTEST, reveal: () => S.staged.splice(0).map((f) => f()) };
}
