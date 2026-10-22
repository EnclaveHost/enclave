// network/direct-chain.mjs -- the supervisor's chain access in independent DIRECT mode (ISOLATION_DIRECT_ONLY=1): every
// read that decides anything is answered by `quorum` of the operator's own RPCs agreeing at ONE fresh, confirmed block,
// through cli/independent.mjs QuorumChain (the reader the owner's CLI and `check` use). There is no first-answer read and
// no fallback: a read that cannot reach agreement throws, and every supervisor caller already treats a throw as
// "unavailable" and fails closed. Legacy (hosted) supervisors never load this file.
//
//   directChainClient(chain)      a viem-PublicClient-shaped object: the methods supervisor.js and its session verifier
//                                 call (readContract, simulateContract, multicall, getLogs, getBlock, getBlockNumber,
//                                 getTransactionReceipt, getTransactionCount, getBalance, getCode, getStorageAt, call),
//                                 plus snapshotScope(fn): every read inside fn is agreed at the SAME block.
//   quorumWalletTransport(chain)  the wallet client's transport. The signed bytes go to EVERY peer; the nonce is the
//                                 AGREED pending nonce; the chain id is the configured one. Gas estimates and fee
//                                 suggestions are the only first-answer calls (among the operator's own RPCs): they can
//                                 make a transaction fail or cost more, never authorize one, and every outcome is read
//                                 back through the quorum.
//   createDirectChain(env)        QuorumChain from BASE_RPCS / CHAIN_QUORUM / CHAIN_CONFIRMATIONS / CHAIN_MAX_BLOCK_AGE_SEC.
import { custom, keccak256, toHex } from "viem";
import { QuorumChain, validateRpcOrigins, agreementKey } from "../cli/independent.mjs";
import { redactUrls } from "./rpc-identity.mjs";

const short = (e) => redactUrls(String(e?.shortMessage || e?.message || e).split("\n")[0]).slice(0, 200);
const isRevert = (e) => { for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (x.name === "ContractFunctionRevertedError" || x.name === "ExecutionRevertedError" || x.name === "CallExecutionError" && /revert/i.test(x.shortMessage || "")) return true; return false; };
const isZeroData = (e) => { for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (x.name === "ContractFunctionZeroDataError") return true; return false; };
const reasonOf = (e) => { for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (x.reason) return String(x.reason).slice(0, 200); return ""; };
const notFound = (e) => e?.name === "TransactionReceiptNotFoundError" || e?.name === "TransactionNotFoundError" || /not.?found|could not be found/i.test(short(e));

/** A fact all agreeing peers reported: rethrown with viem's wording, so message-based callers (sniffCachePolicy) are unchanged. */
function agreedRevert(functionName, reason, block) {
  const m = `The contract function "${functionName}" reverted${reason ? ` with the following reason:\n${reason}` : "."}`;
  return Object.assign(new Error(m), { name: "ContractFunctionExecutionError", shortMessage: m, agreedRevert: true, agreedBlock: block,
    cause: { name: "ContractFunctionRevertedError", reason } });
}
function agreedZeroData(functionName, block) {
  const m = `The contract function "${functionName}" returned no data ("0x").`;
  return Object.assign(new Error(m), { name: "ContractFunctionZeroDataError", shortMessage: m, agreedRevert: true, agreedBlock: block });
}
// A read whose revert is an agreed fact, not a peer failure
const guarded = (op) => async (c, b) => {
  try { return { ok: await op(c, b) }; }
  catch (e) { if (isZeroData(e)) return { noData: true }; if (isRevert(e)) return { revert: reasonOf(e) }; throw e; }
};
const unwrap = (s, functionName) => {
  if (s.value.noData) throw agreedZeroData(functionName, s.blockNumber);
  if (s.value.revert !== undefined) throw agreedRevert(functionName, s.value.revert, s.blockNumber);
  return s.value.ok;
};

/** The same agreement rule as QuorumChain.snapshot, at a block the caller names (a pinned read): every answering peer reads
 *  that block, it must be fresh, unchanged across the read, and `quorum` peers must return the same hash and value. */
export async function agreeAt(chain, block, fn) {
  const failures = [];
  block = BigInt(block);
  if (block < 0n) throw new Error("negative block");
  const results = await Promise.allSettled(chain.peers.map(async ({ client }) => {
    const b = await client.getBlock({ blockNumber: block });
    const t = Number(b.timestamp) * 1000;
    if (!Number.isSafeInteger(t) || t > chain.now() + 15000 || t + chain.maxBlockAgeMs < chain.now()) throw new Error(`stale or future block ${block}`);
    const value = await fn(client, block);
    if ((await client.getBlock({ blockNumber: block })).hash !== b.hash) throw new Error("block replaced during the read");
    return { hash: b.hash, timestamp: t, value, key: b.hash + agreementKey(value) };
  }));
  const groups = new Map();
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return failures.push(`${chain.host(i)}: ${short(r.reason)}`);
    const g = groups.get(r.value.key) || []; g.push(r.value); groups.set(r.value.key, g);
  });
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  if (!best || best.length < chain.quorum) {
    const e = new Error(`no ${chain.quorum} RPCs agreed at block ${block}${groups.size > 1 ? ` (${groups.size} different answers)` : ""}${failures.length ? ` (${failures.slice(0, 4).join("; ")})` : ""}`);
    e.name = "QuorumError"; throw e;
  }
  if (block > chain.lastBlock) chain.lastBlock = block;
  return { value: best[0].value, blockNumber: block, blockHash: best[0].hash, timestamp: best[0].timestamp, agreeing: best.length, peers: chain.peers.length, failures };
}

// the fields every provider returns identically (optional provider extras would make honest peers disagree)
const logView = (l) => ({ address: String(l.address).toLowerCase(), topics: l.topics, data: l.data, blockNumber: l.blockNumber,
  blockHash: l.blockHash, logIndex: l.logIndex, transactionHash: l.transactionHash, transactionIndex: l.transactionIndex,
  ...(l.eventName !== undefined ? { eventName: l.eventName, args: l.args } : {}) });

const view = (r) => r && ({ status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash, transactionHash: r.transactionHash, from: r.from, to: r.to,
  contractAddress: r.contractAddress ?? null, gasUsed: r.gasUsed,
  logs: (r.logs || []).map(logView) });
/** The supervisor's public client in direct mode. `pin` = {block, hash}: a scoped client whose every read is that block. */
export function directChainClient(chain, pin = null) {
  const read = async (fn, blockNumber) => {
    if (pin) {
      if (blockNumber != null && BigInt(blockNumber) !== pin.block) throw new Error(`a snapshot-scoped read asked for block ${blockNumber}, not the scope's ${pin.block}`);
      const s = await agreeAt(chain, pin.block, fn);
      if (s.blockHash !== pin.hash) throw new Error(`block ${pin.block} changed inside one snapshot scope`);
      return s;
    }
    return blockNumber != null ? agreeAt(chain, blockNumber, fn) : chain.snapshot(fn);
  };
  const client = {
    chain: { id: chain.chainId }, transport: { type: "quorum" }, direct: true, quorum: chain.quorum, peers: chain.peers.length,
    getChainId: async () => chain.chainId,
    async getBlockNumber() { return pin ? pin.block : (await chain.snapshot(async () => ({}))).blockNumber; },
    async getBlock({ blockNumber } = {}) {
      const s = await read(async (c, b) => { const x = await c.getBlock({ blockNumber: b }); return { number: x.number, hash: x.hash, timestamp: x.timestamp, parentHash: x.parentHash }; }, blockNumber);
      return { ...s.value, number: s.blockNumber, hash: s.blockHash };
    },
    async readContract({ address, abi, functionName, args = [], blockNumber }) {
      return unwrap(await read(guarded((c, b) => c.readContract({ address, abi, functionName, args, blockNumber: b })), blockNumber), functionName);
    },
    async simulateContract(params) {
      const { blockNumber, ...rest } = params;
      const result = unwrap(await read(guarded(async (c, b) => (await c.simulateContract({ ...rest, blockNumber: b })).result), blockNumber), params.functionName);
      return { result, request: { ...rest } };
    },
    // per-contract reads at ONE block (no Multicall3 dependency); with allowFailure only an AGREED revert is a failure
    async multicall({ contracts, allowFailure = true, blockNumber }) {
      const s = await read(async (c, b) => ({ list: await Promise.all(contracts.map(async (k) => {
        try { return { ok: await c.readContract({ ...k, blockNumber: b }) }; }
        catch (e) { if (isRevert(e) || isZeroData(e)) return { revert: reasonOf(e) }; throw e; }
      })) }), blockNumber);
      return s.value.list.map((x, i) => {
        if (x.revert === undefined) return allowFailure ? { status: "success", result: x.ok } : x.ok;
        const err = agreedRevert(contracts[i].functionName, x.revert, s.blockNumber);
        if (!allowFailure) throw err;
        return { status: "failure", error: err };
      });
    },
    async getLogs(params) {
      const s = await read(async (c, b) => {
        const to = params.toBlock === undefined || params.toBlock === "latest" || BigInt(params.toBlock) > b ? b : BigInt(params.toBlock);
        return { logs: (await c.getLogs({ ...params, toBlock: to })).map(logView) };
      }, null);
      return s.value.logs;
    },
    async getTransactionReceipt({ hash }) {
      const s = await read(async (c, b) => {
        let r; try { r = await c.getTransactionReceipt({ hash }); } catch (e) { if (notFound(e)) return { pending: true }; throw e; }
        if (!r || r.blockNumber > b || (await c.getBlock({ blockNumber: r.blockNumber })).hash !== r.blockHash) return { pending: true };
        return { receipt: view(r) };
      }, null);
      if (s.value.pending) throw Object.assign(new Error(`Transaction receipt with hash "${hash}" could not be found (not mined in an agreed, confirmed block).`), { name: "TransactionReceiptNotFoundError" });
      return s.value.receipt;
    },
    async getTransactionCount({ address, blockNumber, blockTag }) {
      if (blockTag === "pending") return pendingNonce(chain, address);
      return (await read(async (c, b) => ({ n: await c.getTransactionCount({ address, blockNumber: b }) }), blockNumber)).value.n;
    },
    async getBalance({ address, blockNumber }) { return (await read(async (c, b) => ({ v: await c.getBalance({ address, blockNumber: b }) }), blockNumber)).value.v; },
    async getCode({ address, blockNumber }) { return (await read(async (c, b) => ({ v: (await c.getCode({ address, blockNumber: b })) ?? null }), blockNumber)).value.v ?? undefined; },
    async getStorageAt({ address, slot, blockNumber }) { return (await read(async (c, b) => ({ v: (await c.getStorageAt({ address, slot, blockNumber: b })) ?? null }), blockNumber)).value.v ?? undefined; },
    async call({ blockNumber, ...rest }) { return unwrap(await read(guarded(async (c, b) => (await c.call({ ...rest, blockNumber: b })).data ?? null), blockNumber), "call"); },
    /** Every read inside fn(client) comes from ONE agreed block (dependent reads that must not straddle blocks). */
    async snapshotScope(fn) {
      if (pin) return fn(client);
      const s = await chain.snapshot(async () => ({}));
      return fn(directChainClient(chain, { block: s.blockNumber, hash: s.blockHash }));
    },
  };
  return client;
}

/** Each peer's own pending nonce for `address`: at least `quorum` answers, all the same, or it throws (a transaction may
 *  be in flight that some peers see and others do not: never pick one). */
export async function pendingNonce(chain, address) {
  const ns = await chain.each((c) => c.getTransactionCount({ address, blockTag: "pending" }), "pending nonce");
  const distinct = [...new Set(ns.map(String))];
  if (distinct.length !== 1) { const e = new Error(`the RPCs disagree on the pending nonce (${distinct.join(", ")}); a transaction may be in flight`); e.name = "QuorumError"; throw e; }
  return Number(ns[0]);
}

const DEFINITE = /insufficient funds|intrinsic gas|exceeds block gas|invalid sender|invalid signature|transaction type not supported|max fee per gas less than block base fee|fee cap|gas limit reached/i;
/** The signed bytes to EVERY peer. -> hash: some peer accepted (or already knew it), or the outcome is ambiguous (then the
 *  locally computed hash, a PENDING transaction the receipt/intent logic resolves by quorum; never re-signed or resent).
 *  Throws only when every peer definitely refused it: nothing is pending. */
export async function broadcastSigned(chain, raw, { log = () => {} } = {}) {
  const hash = keccak256(raw);
  const sent = await Promise.allSettled(chain.peers.map(({ client }) => client.request({ method: "eth_sendRawTransaction", params: [raw] })));
  let accepted = 0, refused = 0; const reasons = [];
  sent.forEach((r, i) => {
    if (r.status === "fulfilled" && String(r.value).toLowerCase() === hash.toLowerCase()) return accepted++;
    // viem keeps the node's own words in `details` (its shortMessage is generic): classify on all of it
    const m = r.status === "fulfilled" ? `answered ${String(r.value).slice(0, 20)}`
      : redactUrls([r.reason?.shortMessage, r.reason?.details, r.reason?.cause?.message].filter(Boolean).join(" | ")).slice(0, 300);
    if (/already known|known transaction/i.test(m)) return accepted++;
    if (r.status === "rejected" && DEFINITE.test(m)) refused++;
    reasons.push(`${chain.host(i)}: ${m}`);
  });
  if (accepted) return hash;
  if (refused === chain.peers.length) throw new Error(`every RPC refused the transaction; nothing is pending (${reasons.slice(0, 4).join("; ")})`);
  log(`broadcast of ${hash} is ambiguous (${reasons.slice(0, 4).join("; ")}): treated as PENDING, resolved by quorum receipt, never resent`);
  return hash;
}

/** viem transport for the operator's wallet client in direct mode. */
export function quorumWalletTransport(chain, { log = () => {} } = {}) {
  return custom({
    async request({ method, params = [] }) {
      if (method === "eth_chainId") return toHex(chain.chainId);
      if (method === "eth_sendRawTransaction") return broadcastSigned(chain, params[0], { log });
      // one RPC filling nonce, gas and fees in one answer would make that RPC choose the nonce: refused, so viem falls back
      // to the separate calls (the nonce below is agreed; gas and fees stay estimates)
      if (method === "eth_fillTransaction") throw Object.assign(new Error("eth_fillTransaction is not available through the direct-mode quorum transport"), { code: -32601 });
      if (method === "eth_getTransactionCount") {
        if (params[1] === "pending") return toHex(await pendingNonce(chain, params[0]));
        const s = await chain.snapshot(async (c, b) => ({ n: await c.getTransactionCount({ address: params[0], blockNumber: b }) }));
        return toHex(s.value.n);
      }
      // estimates and fee suggestions only: the first of the operator's own RPCs that answers (documented; not an authority)
      let last;
      for (const { client } of chain.peers) { try { return await client.request({ method, params }); } catch (e) { last = e; } }
      throw last || new Error(`no RPC answered ${method}`);
    },
  }, { retryCount: 0 });
}

/** The supervisor's direct-mode chain from its environment. -> {chain, problems[]} (problems non-empty: refuse to start). */
export function createDirectChain(env = process.env, { now = Date.now } = {}) {
  const problems = [];
  const list = String(env.BASE_RPCS || "").split(",").map((s) => s.trim()).filter(Boolean);
  let rpcs = null;
  try { rpcs = validateRpcOrigins(list); } catch (e) { problems.push(`BASE_RPCS: ${e.message}`); }
  const int = (k, lo, hi, d) => { const raw = env[k]; if (raw === undefined || raw === "") return d; const n = Number(raw); if (!Number.isSafeInteger(n) || n < lo || n > hi) { problems.push(`${k} must be an integer ${lo}-${hi}`); return d; } return n; };
  const quorum = int("CHAIN_QUORUM", 2, 8, 2), confirmations = int("CHAIN_CONFIRMATIONS", 0, 64, 2), age = int("CHAIN_MAX_BLOCK_AGE_SEC", 10, 86400, 120);
  if (rpcs && quorum > rpcs.length) problems.push(`CHAIN_QUORUM ${quorum} exceeds the ${rpcs.length} RPCs in BASE_RPCS`);
  if (problems.length) return { chain: null, problems };
  return { chain: new QuorumChain({ rpcs, quorum, confirmations, maxBlockAgeMs: age * 1000, now }), problems };
}
