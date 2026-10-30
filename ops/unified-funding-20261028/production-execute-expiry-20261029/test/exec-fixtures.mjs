// UNREVIEWED, NOT RUN. Offline fixtures for test/*.test.mjs (execute-expiry-recovery-r1; ported from
// client-execution-recovery-root-r1/test/exec-fixtures.mjs). IMPORT ADJUSTMENT: every module is now the CANONICAL
// source/sdk/funding module (the candidate under test imports the same instances through sdk/funding/* shims).
// The one non-import change: cfg / runtime / the address constants were previously re-exported from
// client-repair-r4/test/fixtures.mjs, whose cfg is built by the client-r1 codec; the canonical codec trusts only configs
// produced by ITS OWN fundingConfig (a module-local WeakSet), so the identical values are built here with it. The
// runtime additionally carries pins.codehashes (as verifyRuntime returns) so the expiry proof can check the implementation.
// REAL: Node WebCrypto non-extractable P-256 keys and signatures, the canonical codec, MemoryV2Store, relayClient,
// canonicalReceipt / receiptFinality / verifySettlement. SCRIPTED: the chain and the relay. No network, wallet or funds.
import {
  encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, toHex,
} from "../../../source/node_modules/viem/_esm/index.js";
import { privateKeyToAccount } from "../../../source/node_modules/viem/_esm/accounts/index.js";
import { GAS_FUNDED_EVENT, SESSION_OP_EVENT, buildGasFundCall, fundingConfig, predictVault } from "../../../source/sdk/funding/funding-codec.mjs";
import { MemoryV2Store, newGasKey, newGasRecord } from "../../../source/sdk/funding/v2-store.mjs";
import { relayClient } from "../../../source/sdk/funding/funding-client.mjs";
import { lower } from "../../../source/sdk/funding/util.mjs";

// ---- identities (same values as client-repair-r4/test/fixtures.mjs) ---------------------------------------------------
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";   // public anvil key #0
export const OWNER = privateKeyToAccount(TEST_KEY).address;
export const A = (b) => `0x${b.repeat(20)}`;
export const FACTORY = A("11"), IMPL = A("22"), ADAPTER = A("33"), LFACTORY = A("44"), LVAULT = A("55"), USDC = A("66"), RELAYER = A("77");
export const NOW = 1793202897n;
export const DEP = `0x${"d1".repeat(32)}`;
export const TX = (b) => `0x${b.repeat(32)}`;
export const cfg = fundingConfig({ chainId: 8453, factory: FACTORY, implementation: IMPL, vault: predictVault(FACTORY, IMPL, OWNER),
  owner: OWNER, gasAdapter: ADAPTER, legacyFactory: LFACTORY, legacyVault: LVAULT, adapterMaxEthOut: 10n ** 17n,
  adapterFeeTiers: [500, 3000] });
/** Scripted runtime code of the implementation; its keccak is the runtime's verified pin. */
export const IMPL_CODE = "0x6080604052348015600f57600080fd5b50";
export const runtime = Object.freeze({ cfg,
  pins: { usdc: USDC, legacyFactory: LFACTORY, codehashes: { factory: TX("c1"), implementation: keccak256(IMPL_CODE), gasAdapter: TX("c3") } },
  intake: { openEnabled: true, ownerEnabled: true, feeTiers: [500, 3000], relayer: RELAYER }, intakeWhy: null, relayer: RELAYER });

export const RELAY_BASE = "https://relay.fixture.invalid";
export const SID = TX("73");
export const EXECUTE_ABI = [{ type: "function", name: "execute", stateMutability: "nonpayable",
  inputs: [{ name: "sid", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "action", type: "uint8" },
    { name: "args", type: "bytes" }, { name: "fee", type: "uint256" }, { name: "deadline", type: "uint64" },
    { name: "x", type: "uint256" }, { name: "y", type: "uint256" }, { name: "r", type: "bytes32" }, { name: "sv", type: "bytes32" }],
  outputs: [{ name: "result", type: "bytes" }] }];
export const code = (c) => (e) => e?.code === c;

/** Counts every WebCrypto sign() (to prove reconcile signs nothing). */
export function countingSubtle() {
  const c = { n: 0, sign: async (...a) => { c.n += 1; return crypto.subtle.sign(...a); } };
  return c;
}

// ---- scripted chain -------------------------------------------------------------------------------------------------
export function chain() {
  const W = { head: 100n, time: NOW, finalized: 100n, salt: new Map(), txAt: new Map(), receipts: new Map(), txs: new Map(),
    hidden: new Set(), logs: [], calls: [], logRanges: [], extraTx: new Map() };
  W.hash = (n) => keccak256(toHex(BigInt(n) * 1000n + BigInt(W.salt.get(BigInt(n)) ?? 0), { size: 32 }));
  W.block = (n) => ({ number: toHex(n), hash: W.hash(n), timestamp: toHex(W.time), transactions: W.txAt.get(BigInt(n)) ?? [] });
  W.mineEmpty = (k = 1) => { for (let i = 0; i < k; i++) W.head += 1n; };
  let seq = 0n;
  /** One transaction in a new block: { to, input, logs: [{address, topics, data}], status } -> hash */
  W.mineTx = ({ to, input, logs = [], status = "0x1" }) => {
    const n = (W.head += 1n);
    const h = keccak256(toHex((seq += 1n) + 5000n, { size: 32 }));
    const bh = W.hash(n);
    const full = logs.map((l, i) => ({ ...l, address: lower(l.address), transactionHash: h, blockHash: bh, blockNumber: toHex(n),
      transactionIndex: "0x0", logIndex: toHex(i), removed: false }));
    W.txAt.set(n, [h]);
    W.receipts.set(h, { transactionHash: h, transactionIndex: "0x0", blockHash: bh, blockNumber: toHex(n), status, to: lower(to), logs: full });
    W.txs.set(h, { hash: h, blockHash: bh, blockNumber: toHex(n), transactionIndex: "0x0", to: lower(to), input });
    W.logs.push(...full);
    return h;
  };
  /** Replace the canonical block at height n (the old receipt now points at a non-canonical hash). */
  W.reorg = (n) => { W.salt.set(BigInt(n), (W.salt.get(BigInt(n)) ?? 0) + 1); };
  W.rpc = async (method, params = []) => {
    W.calls.push(method);
    if (method === "eth_getBlockByNumber") {
      const t = params[0];
      const n = t === "latest" ? W.head : t === "finalized" ? W.finalized : BigInt(t);
      return n <= W.head && n > 0n ? W.block(n) : null;
    }
    if (method === "eth_getTransactionReceipt") return W.hidden.has(params[0]) ? null : (W.receipts.get(params[0]) ?? null);
    if (method === "eth_getTransactionByHash") return W.extraTx.get(params[0]) ?? W.txs.get(params[0]) ?? null;
    if (method === "eth_getLogs") {
      const f = params[0];
      const from = BigInt(f.fromBlock), to = BigInt(f.toBlock);
      W.logRanges.push([from, to]);
      return W.logs.filter((l) => !W.hidden.has(l.transactionHash) && lower(l.address) === lower(f.address)
        && f.topics.every((t, i) => t == null || l.topics[i] === t) && BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to);
    }
    throw new Error(`unscripted ${method}`);
  };
  return W;
}

// ---- settlement events (the codec's own event ABIs; canonical encodings) --------------------------------------------
const nonIndexed = (ev) => ev.inputs.filter((p) => !p.indexed).map((p) => ({ type: p.type }));
export function settlementLogs({ sid, nonce, args, fee, deployment, holder, ethOut, maxUsdcIn6, used, relayer = RELAYER, argsHash = keccak256(args) }) {
  const refund = BigInt(maxUsdcIn6) - BigInt(used);
  const result = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(used), refund]);
  return [
    { address: cfg.vault, topics: encodeEventTopics({ abi: [SESSION_OP_EVENT], eventName: "SessionOp", args: { sid, action: 10 } }),
      data: encodeAbiParameters(nonIndexed(SESSION_OP_EVENT), [BigInt(nonce), argsHash, BigInt(used), BigInt(fee), result]) },
    { address: cfg.vault, topics: encodeEventTopics({ abi: [GAS_FUNDED_EVENT], eventName: "GasFunded", args: { sid, deployment, holder } }),
      data: encodeAbiParameters(nonIndexed(GAS_FUNDED_EVENT), [BigInt(ethOut), BigInt(used), BigInt(maxUsdcIn6), relayer, BigInt(fee)]) },
  ];
}
export const R32 = `0x${"ab".repeat(32)}`;
export const executeInput = (b) => encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute",
  args: [b.sid, BigInt(b.nonce), 10, b.args, BigInt(b.fee), BigInt(b.deadline), BigInt(b.x), BigInt(b.y), R32, R32] });

// ---- record + review --------------------------------------------------------------------------------------------------
export async function setup() {
  const key = await newGasKey(crypto.subtle);
  const record = newGasRecord({ key, chainId: 8453, relay: RELAY_BASE, owner: cfg.owner, vault: cfg.vault, factory: FACTORY,
    implementation: IMPL, label: "Gas recovery · test", now: Number(NOW) });
  Object.assign(record, { sid: SID, status: "open", grant: { apps: [DEP] }, grantDigest: TX("ab") });
  const store = new MemoryV2Store();
  await store.saveKey(record);
  return { record: await store.loadKey(record.id), store, W: chain() };
}
export const INTENT = { ethOut: 20_000_000_000_000n, maxUsdcIn6: 50_000n, fee: 500 };
export function reviewFor(record, { seq = 0n, fee = 25_000n, deadline = NOW + 300n, maxUsdcIn6 = INTENT.maxUsdcIn6 } = {}) {
  const nonce = (1n << 64n) | seq;
  const intent = { payer: cfg.vault, deployment: DEP, expectedOwner: cfg.legacyVault, ethOut: INTENT.ethOut, maxUsdcIn6, fee: INTENT.fee, deadline };
  const call = buildGasFundCall(cfg, { domainVersion: "2", now: NOW, sessionId: record.sid, nonce, action: 10, intent, fee, deadline });
  return { call, sid: record.sid, deployment: DEP, holder: cfg.legacyVault, env: 2,
    totals: { maxUsdcIn6, fee6: fee, totalMaximum6: maxUsdcIn6 + fee, balance6: 1_000_000n } };
}

// ---- scripted relay: `mode` decides what the relay did and what reached the client ----------------------------------
/** modes: ok | body (mined; body lost after 200 headers) | gw502 (mined; gateway 502) | lost (mined; connection reset)
 *  | unreachable (nothing reached the relay) | malformed (mined; 200 HTML) | nohash (mined; 200 {}) | refuse (409 quote_moved)
 *  | revert409 (host 409 "revert") | pending (mined, receipt hidden; 202 + txHash) | notmined200 (200 with a hash never mined) */
export function relayFor(W, opts = {}) {
  const R = { posts: 0, gets: 0, mode: opts.mode ?? "ok", used: opts.used ?? 40_000n, last: null, sessionOps: [] };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (init.method === "GET") {
      R.gets += 1;
      if (path.startsWith("/v1/sessions/funding/session/")) return { status: 200, ok: true, text: async () => JSON.stringify({ ops: R.sessionOps }) };
      return { status: 404, ok: false, text: async () => JSON.stringify({ error: "not found", code: "not_found" }) };
    }
    R.posts += 1;
    const b = JSON.parse(init.body);
    const mode = R.mode;
    if (mode === "unreachable") throw new TypeError("fetch failed: connect ECONNREFUSED");
    if (mode === "refuse") return { status: 409, ok: false, text: async () => JSON.stringify({ error: "the pool now needs more; re-quote", code: "quote_moved" }) };
    if (mode === "revert409") return { status: 409, ok: false, text: async () => JSON.stringify({ error: "funding gas.fund reverted on-chain", code: "revert" }) };
    let h = null;
    if (mode !== "notmined200") {
      const args = b.args;
      h = W.mineTx({ to: cfg.vault, input: executeInput(b), logs: settlementLogs({ sid: b.sid, nonce: b.nonce, args, fee: b.fee, deployment: DEP,
        holder: cfg.legacyVault, ethOut: INTENT.ethOut, maxUsdcIn6: opts.maxUsdcIn6 ?? INTENT.maxUsdcIn6, used: R.used }) });
      R.last = h;
      if (opts.index !== false) R.sessionOps.push({ nonce: String(b.nonce), tx: h });
    } else h = TX("99");
    if (mode === "ok") return { status: 200, ok: true, text: async () => JSON.stringify({ txHash: h, settlement: { actual: { totalDebit6: `${R.used + BigInt(b.fee)}n` } } }) };
    if (mode === "body") return { status: 200, ok: true, text: async () => { throw new TypeError("terminated response body"); } };
    if (mode === "gw502") return { status: 502, ok: false, text: async () => "Bad Gateway" };
    if (mode === "lost") throw new TypeError("fetch failed: socket hang up");
    if (mode === "malformed") return { status: 200, ok: true, text: async () => "<html>ok</html>" };
    if (mode === "nohash") return { status: 200, ok: true, text: async () => "{}" };
    if (mode === "pending") { W.hidden.add(h); return { status: 202, ok: false, text: async () => JSON.stringify({ error: "not yet canonical", code: "pending_reconciliation", txHash: h }) }; }
    if (mode === "notmined200") return { status: 200, ok: true, text: async () => JSON.stringify({ txHash: h }) };
    throw new Error(`unscripted relay mode ${mode}`);
  };
  R.relay = relayClient(RELAY_BASE, fetchImpl);
  return R;
}
