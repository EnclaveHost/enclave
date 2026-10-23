// Independent mode for the enclave CLI: every authority decision comes from explicit pins (a reviewed authority profile
// checked against the digest the user supplies, or a --contract-pins document) and from k-of-n RPCs that return
// identical answers at the SAME confirmed, fresh block. There is no Enclave API or first-answer fallback. Existing
// session factories may resolve their on-chain book at that same block, subject to the selected ledger/catalog pins.
// A read that cannot reach quorum fails, and a failure is never reported as an empty answer.
// Transactions are signed once, broadcast unchanged and confirmed by the same quorum; an outcome that cannot be
// confirmed is reported as unknown and never re-signed or resent.
import { chainVerifierOf, createVerifiedSnapshot, verifierRequest, verifierClient } from "../network/verified-chain.mjs";
import fs from "node:fs";
import { createPublicClient, http as viemHttp, keccak256, toBytes, getAddress, encodeFunctionData } from "viem";
import { base } from "viem/chains";
import { boundedFetch, parseProfile, contractPinsFromProfile, MAX_PROFILE_BYTES } from "../network/authority-profile.mjs";
import { rpcEndpoint, rpcLabel, redactUrls } from "../network/rpc-identity.mjs";
import { hostLiveness, REGISTRY_UPDATE_WINDOW_SEC } from "../network/host-liveness.mjs";

export const BASE_CHAIN_ID = 8453;
const ZERO = "0x" + "0".repeat(40);
const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const nonZero = (a) => isAddress(a) && !/^0x0{40}$/i.test(a);

// ---- trust ---------------------------------------------------------------------------------------------------------

/** RPC origins for a quorum: 2-8 URLs under the URL policy every independent reader shares (network/rpc-identity.mjs:
 *  HTTPS, plain HTTP only on loopback, no credentials or fragment), each a DISTINCT vote by its canonical identity (one
 *  public host is one vote however it is addressed; loopback counts by port). Messages carry only redacted labels. */
export function validateRpcOrigins(list, { min = 2 } = {}) {
  if (!Array.isArray(list) || list.length < min || list.length > 8)
    throw new Error(min === 2 ? "independent mode needs 2 to 8 explicit RPC origins (--rpc a,b[,c]); there is no default RPC set"
      : `the explicit transaction transport takes ${min} to 8 RPC origins (--rpc); there is no default RPC set`);
  const seen = new Map();
  return list.map((raw) => {
    let e;
    try { e = rpcEndpoint(raw); } catch (err) { throw new Error(`${err.message} (${rpcLabel(raw)})`); }
    if (seen.has(e.identity)) throw new Error(`RPCs ${seen.get(e.identity)} and ${e.label} are one vote (${e.identity}); a quorum needs distinct hosts`);
    seen.set(e.identity, e.label);
    return e.url.href.replace(/\/$/, "") === e.url.origin ? e.url.origin : e.url.href;
  });
}

function intIn(v, lo, hi, dflt, what) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < lo || n > hi) throw new Error(`${what} must be an integer from ${lo} to ${hi}`);
  return n;
}

/**
 * Resolve the explicit trust for independent mode.
 *  profileFile+profileDigest: a reviewed authority profile (network/authority-profile.mjs); its contract pins and USDC.
 *  contractPins (already validated by network/contract-pins.mjs) and usdc: the pin-only alternative.
 *  If both a profile and pins are given they must be identical. -> {pins, usdc, profile, digest, rpcs, quorum, ...}
 */
export function loadIndependentTrust({ profileFile, profileDigest, contractPins, usdc, defaultUsdc, rpcs, quorum, confirmations, maxBlockAgeSec, chainVerifier }) {
  let profile = null, digest = null, pins = contractPins || null, token = usdc ? String(usdc) : null;
  if (profileDigest && !profileFile) throw new Error("--profile-digest needs --profile");
  if (profileFile) {
    if (!profileDigest) throw new Error("--profile needs --profile-digest sha256:<the reviewed digest>; a profile never vouches for itself");
    const fd = fs.openSync(profileFile, "r");
    let bytes;
    try { const b = Buffer.alloc(MAX_PROFILE_BYTES + 1); let n = 0; for (;;) { const r = fs.readSync(fd, b, n, b.length - n, null); if (!r) break; n += r; if (n > MAX_PROFILE_BYTES) break; } bytes = b.subarray(0, n); }
    finally { fs.closeSync(fd); }
    ({ profile, digest } = parseProfile(bytes, { expectedDigest: String(profileDigest) }));
    const derived = contractPinsFromProfile(profile).contracts;
    if (pins) for (const [k, v] of Object.entries(derived))
      if (String(pins[k]).toLowerCase() !== v) throw new Error(`--contract-pins ${k} differs from the reviewed profile`);
    pins = Object.freeze({ ...derived });
    const pu = profile.contracts.usdc.address;
    if (token && token.toLowerCase() !== pu) throw new Error("--usdc differs from the reviewed profile's payment token");
    token = pu;
  }
  if (!pins) throw new Error("independent mode needs explicit authorities: --profile FILE --profile-digest sha256:… or --contract-pins FILE");
  token = token || defaultUsdc;
  if (!nonZero(token)) throw new Error("independent mode needs a payment token address (--usdc)");
  // --chain-verifier (optional, loopback only): the local proof-backed verifier becomes the authority for EVERY chain state
  // read of independent mode (independentChain: one verified block per snapshot; a refusal never falls back). The --rpc list
  // is then optional and is only the explicit TRANSACTION/HISTORY transport (nonce, gas, fees, broadcast, receipts, log
  // hints): untrusted for state. Without a verifier the RPC quorum is the authority, as before.
  const verifier = chainVerifier ? chainVerifierOf({ chainAuthority: "verifier", chainVerifier }, "--chain-verifier") : null;
  const origins = verifier && !(Array.isArray(rpcs) && rpcs.length) ? [] : validateRpcOrigins(rpcs, { min: verifier ? 1 : 2 });
  const q = verifier ? origins.length : intIn(quorum, 2, origins.length, 2, "--quorum");
  return Object.freeze({ pins, usdc: getAddress(token), profile, digest, rpcs: origins, quorum: q,
    confirmations: intIn(confirmations, 0, 64, 2, "--confirmations"), maxBlockAgeMs: intIn(maxBlockAgeSec, 10, 86400, 120, "--max-block-age") * 1000, chainVerifier: verifier });
}

// ---- quorum reads ----------------------------------------------------------------------------------------------------

export class QuorumError extends Error {
  constructor(message, { failures = [] } = {}) {
    super(message + (failures.length ? ` (${failures.slice(0, 6).join("; ")})` : ""));
    this.name = "QuorumError"; this.failures = failures;
  }
}
// peer failures are printed: any URL in them (viem embeds the request URL, which may carry an API key) is redacted
const short = (e) => redactUrls(String(e?.shortMessage || e?.message || e).split("\n")[0]).slice(0, 160);
// Only a REVERT is a fact about the contract; transport trouble, "returned no data" and anything else are not.
const isRevert = (e) => { for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (x.name === "ContractFunctionRevertedError" || x.name === "ExecutionRevertedError") return true; return false; };
const revertReason = (e) => { for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (x.reason) return String(x.reason).slice(0, 200); return short(e).replace(/^.*?reverted(?: with the following reason:)?:?\s*/i, "").slice(0, 200); };
// Agreement compares the decoded value: bigints and nested arrays/objects, keys in order.
export const agreementKey = (v) => JSON.stringify(v, (_k, x) => typeof x === "bigint" ? { $b: x.toString() } : x instanceof Uint8Array ? { $u: Buffer.from(x).toString("hex") } : x);

export class QuorumChain {
  /** rpcs: validated origins; clients (tests): [{origin, client}] with viem public-client methods. */
  // minPeers (default 2: a quorum): 1 only for VerifiedChain's explicit transaction transport, never a state authority
  constructor({ rpcs, clients, quorum = 2, confirmations = 2, maxBlockAgeMs = 120000, chainId = BASE_CHAIN_ID, now = Date.now, timeoutMs = 12000, minPeers = 2 }) {
    this.peers = clients || rpcs.map((origin) => ({ origin, client: createPublicClient({ chain: base,
      transport: viemHttp(origin, { retryCount: 0, timeout: timeoutMs, fetchFn: boundedFetch({ timeoutMs }) }) }) }));
    if (this.peers.length < minPeers || quorum < Math.min(2, minPeers) || quorum > this.peers.length) throw new Error("a quorum needs at least two of the configured RPCs");
    Object.assign(this, { quorum, confirmations, maxBlockAgeMs, chainId, now });
    this.lastBlock = 0n;
  }
  host(i) { try { return new URL(this.peers[i].origin).host; } catch { return "rpc" + i; } }
  /** The highest block at least `quorum` peers have, minus the confirmations, and never below one already used. */
  async pickBlock(failures) {
    const heads = await Promise.allSettled(this.peers.map(async ({ client }) => {
      const [id, n] = await Promise.all([client.getChainId(), client.getBlockNumber({ cacheTime: 0 })]);
      if (Number(id) !== this.chainId) throw new Error(`wrong chain ${id}`);
      return BigInt(n);
    }));
    const ok = [];
    heads.forEach((h, i) => h.status === "fulfilled" ? ok.push({ i, n: h.value }) : failures.push(`${this.host(i)}: ${short(h.reason)}`));
    if (ok.length < this.quorum) throw new QuorumError(`chain quorum unavailable: ${ok.length} of ${this.peers.length} RPCs answered on chain ${this.chainId}, ${this.quorum} required`, { failures });
    ok.sort((a, b) => (a.n > b.n ? -1 : a.n < b.n ? 1 : 0));
    let block = ok[this.quorum - 1].n - BigInt(this.confirmations);
    if (block < 0n) throw new QuorumError("no confirmed block yet", { failures });
    if (block < this.lastBlock) block = this.lastBlock;
    return { block, candidates: ok.filter((h) => h.n >= block).map((h) => h.i) };
  }
  /** One value read by every candidate peer at one block; returned once `quorum` peers agree on it and on the block. */
  async snapshot(fn) {
    const failures = [];
    const { block, candidates } = await this.pickBlock(failures);
    const results = await Promise.allSettled(candidates.map(async (i) => {
      const c = this.peers[i].client;
      const b = await c.getBlock({ blockNumber: block });
      const t = Number(b.timestamp) * 1000;
      if (!Number.isSafeInteger(t) || t > this.now() + 15000 || t + this.maxBlockAgeMs < this.now()) throw new Error(`stale block ${block}`);
      const value = await fn(c, block);
      if ((await c.getBlock({ blockNumber: block })).hash !== b.hash) throw new Error("block replaced during the read");
      return { i, hash: b.hash, timestamp: t, value, key: b.hash + agreementKey(value) };
    }));
    const groups = new Map();
    results.forEach((r, j) => {
      if (r.status !== "fulfilled") return failures.push(`${this.host(candidates[j])}: ${short(r.reason)}`);
      const g = groups.get(r.value.key) || []; g.push(r.value); groups.set(r.value.key, g);
    });
    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    if (!best || best.length < this.quorum) {
      if (groups.size > 1) failures.push(`${groups.size} different answers`);
      throw new QuorumError(`no ${this.quorum} RPCs agreed at block ${block}`, { failures });
    }
    if (block > this.lastBlock) this.lastBlock = block;
    return { value: best[0].value, blockNumber: block, blockHash: best[0].hash, timestamp: best[0].timestamp,
      agreeing: best.length, peers: this.peers.length, failures };
  }
  /** readContract at an agreed block. An agreed revert throws an "execution reverted" error (a fact, not an outage). */
  async read(address, abi, functionName, args = []) {
    const s = await this.snapshot(async (c, blockNumber) => {
      try { return { ok: await c.readContract({ address, abi, functionName, args, blockNumber }) }; }
      catch (e) { if (isRevert(e)) return { revert: revertReason(e) }; throw e; }
    });
    if (s.value.revert !== undefined) throw Object.assign(new Error(`execution reverted: ${s.value.revert}`), { agreedRevert: true });
    return s.value.ok;
  }
  balance(address) { return this.snapshot((c, blockNumber) => c.getBalance({ address, blockNumber })).then((s) => s.value); }
  /** Several reads in ONE snapshot. calls: [{address, abi, functionName, args, optional}]; an optional call's agreed
   *  revert yields null instead of failing the whole snapshot. */
  async readMany(calls) {
    return this.snapshot((c, blockNumber) => Promise.all(calls.map(async (k) => {
      try { return await c.readContract({ address: k.address, abi: k.abi, functionName: k.functionName, args: k.args || [], blockNumber }); }
      catch (e) { if (k.optional && isRevert(e)) return null; throw e; }
    })));
  }
  /** Each peer's own answer to a call that is not block-scoped (pending nonce, gas, fees): at least `quorum` answers. */
  async each(fn, what) {
    const failures = [];
    const rs = await Promise.allSettled(this.peers.map(({ client }) => fn(client)));
    const ok = [];
    rs.forEach((r, i) => r.status === "fulfilled" ? ok.push(r.value) : failures.push(`${this.host(i)}: ${short(r.reason)}`));
    if (ok.length < this.quorum) throw new QuorumError(`${what}: ${ok.length} of ${this.peers.length} RPCs answered, ${this.quorum} required`, { failures });
    return ok;
  }
}

// ---- the explicit local verifier as independent mode's chain authority ---------------------------------------------
const NO_TX = "under --chain-verifier this needs the explicit transaction/history transport (--rpc); there is none, and no public default is used";
// A verifier refusal of an eth_call that is an execution revert (JSON-RPC code 3 or "execution reverted") is a proof-backed
// fact about the contract, reported like an agreed revert; anything else stays an outage.
const verifiedRevert = (e) => e?.rpcCode === 3 || /execution reverted|\brevert(ed)?\b/i.test(String(e?.message || ""));
function asRevert(e) { const reason = String(e?.message || "").replace(/^verifier:\s*/, "").replace(/^.*?execution reverted:?\s*/i, "").slice(0, 200);
  return Object.assign(new Error(`execution reverted: ${reason}`), { name: "ExecutionRevertedError", reason, cause: e }); }
/**
 * The QuorumChain interface over the local proof-backed verifier (network/verified-chain.mjs createVerifiedSnapshot: one
 * confirmed, fresh, monotonic block per snapshot, the header re-checked, ONE whole-operation deadline, a terminal client):
 *   * snapshot(fn, {atBlock}) - fn(client, blockNumber) with the pinned client (readContract, getCode, getStorageAt,
 *     getBalance, getBlock at that block, and `call` for simulation); read/readMany/balance as QuorumChain's, on it;
 *     `getLogs` / eth_getLogs inside a snapshot are DISCOVERY HINTS from the explicit transport only, clamped to the verified
 *     block (callers verify every candidate by state reads); without a transport they refuse by name;
 *   * each(), peers, host(), receiptSnapshot(): the explicit TRANSACTION/HISTORY transport (the --rpc list, all of which
 *     must answer alike), untrusted for state; without one they refuse by name. Nothing falls back to a public default.
 */
export class VerifiedChain {
  constructor({ verifier, txRpcs = [], txClients = null, chainId = BASE_CHAIN_ID, confirmations = 2, maxBlockAgeMs = 120000, now = Date.now, timeoutMs = 12000, deadlineMs = 30000 }) {
    this.authority = "local-verifier"; this.verifier = verifier;
    Object.assign(this, { chainId, confirmations, maxBlockAgeMs, now });
    this.policy = { verifier, chainId, confirmations, maxBlockAgeMs, deadlineMs, now, allowCall: true };
    this.snap = createVerifiedSnapshot(this.policy);
    const n = (txClients || txRpcs).length;
    this.tx = n ? new QuorumChain({ rpcs: txRpcs, clients: txClients || undefined, quorum: n, minPeers: 1, confirmations, maxBlockAgeMs, chainId, now, timeoutMs }) : null;
    this.peers = this.tx ? this.tx.peers : [];
    this.quorum = this.tx ? this.tx.quorum : 1;
    this.lastBlock = 0n;
  }
  host(i) { return this.tx ? this.tx.host(i) : "verifier"; }
  #client(c, b) {
    const hints = async (q) => {
      if (!this.tx) throw Object.assign(new Error(`getLogs: ${NO_TX}`), { code: "chain_unsupported" });
      const to = q.toBlock === undefined || BigInt(q.toBlock) > b ? b : BigInt(q.toBlock);
      const all = await this.tx.each((cl) => cl.getLogs({ ...q, toBlock: to }), "log hints (explicit transport, untrusted)");
      if (new Set(all.map(agreementKey)).size !== 1) throw new QuorumError("log hints: the transaction transports disagree");
      return all[0];
    };
    return new Proxy(Object.freeze({}), { get(_t, key) {
      if (key === "getLogs") return hints;
      if (key === "request") return async ({ method, params }) => {
        if (method !== "eth_getLogs") throw Object.assign(new Error(`${method}: not a verified state read (${NO_TX})`), { code: "chain_unsupported" });
        const p = params?.[0] || {};
        const logs = await hints({ address: p.address, topics: p.topics, fromBlock: BigInt(p.fromBlock), toBlock: BigInt(p.toBlock) });
        return logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: "0x" + BigInt(l.blockNumber).toString(16), logIndex: "0x" + Number(l.logIndex).toString(16) }));
      };
      if (key === "readContract" || key === "call") return async (q) => { try { return await c[key](q); } catch (e) { throw verifiedRevert(e) ? asRevert(e) : e; } };
      return c[key];
    } });
  }
  async snapshot(fn, { atBlock = null } = {}) {
    // a resumed block ({number, hash} this chain already accepted: one MCP call's later reads, pagination) is read by a fresh
    // snapshot function - the exact hash must still be canonical and fresh - so a newer block accepted meanwhile by another
    // call cannot refuse it; fresh reads keep the monotonic floor
    const snap = atBlock ? createVerifiedSnapshot(this.policy) : this.snap;
    const s = await snap((c, b) => fn(this.#client(c, b), b), atBlock ? { atBlock } : {});
    if (s.blockNumber > this.lastBlock) this.lastBlock = s.blockNumber;
    return { value: s.value, blockNumber: s.blockNumber, blockHash: s.blockHash, timestamp: s.timestamp, agreeing: 1, peers: 1, failures: [], evidence: s.evidence };
  }
  each(fn, what) { if (!this.tx) return Promise.reject(Object.assign(new QuorumError(`${what}: ${NO_TX}`), { code: "chain_unsupported" })); return this.tx.each(fn, what); }
  /** Wait (bounded) until a VERIFIED block reaches `n`: after a transport-reported receipt, later reads are then at or after
   *  the block the transport says it was mined in (read-your-writes); a transport claiming a block the verifier never
   *  reaches leaves the outcome unknown, never "done". -> the snapshot that reached it, or null on timeout. */
  async awaitBlock(n, { timeoutMs = 120000, pollMs = 1000 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try { const s = await this.snapshot(async () => 0); if (s.blockNumber >= BigInt(n)) return s; } catch {}
      if (Date.now() >= end) return null;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  /** The sender's account nonce in VERIFIED state (proof-backed) at a fresh verified block: -> { nonce, blockNumber }. */
  async verifiedNonce(address) {
    const s = await this.snapshot(async () => 0);
    const n = await verifierRequest(this.verifier)("eth_getTransactionCount", [address, { blockHash: s.blockHash }]);
    return { nonce: BigInt(n), blockNumber: s.blockNumber, blockHash: s.blockHash };
  }
  /** Refuses a transport-supplied nonce that verified state already shows used (a stale or lying transport). */
  async assertNonceUnused(address, nonce) {
    const v = await this.verifiedNonce(address);
    if (BigInt(nonce) < v.nonce) throw new Error(`refusing to send: the transport's pending nonce ${nonce} for ${address} is already used in verified state (nonce ${v.nonce} at block ${v.blockNumber}); nothing was signed`);
    return v;
  }
  /**
   * What the verifier CAN establish after a transport reports a receipt (E's verified-receipt path does not exist yet):
   *   * the verifier reaches the reported block (read-your-writes: later reads see at least that state);
   *   * the sender's nonce is consumed in verified state (no replay: those bytes or that nonce can never be used again; with
   *     the nonce checked unused before signing (assertNonceUnused), only a transaction this account signed can have used it);
   *   * optionally `confirm(chain)` - the caller's own check of the intended effect through verified reads.
   * It does NOT authenticate the receipt's contents, the transaction's inclusion or its success: those stay
   * "transport-reported (unverified)" unless `confirm` proves the effect. -> evidence, or throws a final OutcomeUnknownError.
   */
  async verifyOutcome({ hash, from, nonce, receiptBlock, confirm = null, timeoutMs = 120000, pollMs = 1000 }) {
    const reached = await this.awaitBlock(receiptBlock, { timeoutMs, pollMs });
    if (!reached) throw Object.assign(new OutcomeUnknownError(hash, `the transport reports it mined in block ${receiptBlock}, but the local verifier has not reached that block`), { final: true });
    const n = await this.verifiedNonce(from);
    if (n.nonce <= BigInt(nonce)) throw Object.assign(new OutcomeUnknownError(hash, `the transport reports it mined in block ${receiptBlock}, but nonce ${nonce} of ${from} is still unused in verified state at block ${n.blockNumber}`), { final: true });
    let effect = "not checked";
    if (confirm) {
      if (!(await confirm(this))) throw Object.assign(new OutcomeUnknownError(hash, `the transport reports success, but its effect is not visible in verified state at block ${n.blockNumber}`), { final: true });
      effect = "verified";
    }
    return { postStateBlock: n.blockNumber, nonceConsumed: "verified", effect,
      receipt: "transport-reported (unverified: contents, inclusion and status are not proven)", stateVerified: effect === "verified" };
  }
  /** receipts, transactions, nonce counts at a block: the explicit transport's own snapshot (untrusted for state). */
  receiptSnapshot(fn) { if (!this.tx) return Promise.reject(Object.assign(new QuorumError(`receipt: ${NO_TX}`), { code: "chain_unsupported" })); return this.tx.snapshot(fn); }
}
for (const m of ["read", "readMany", "balance"]) VerifiedChain.prototype[m] = QuorumChain.prototype[m];
/** independent mode's chain: VerifiedChain under --chain-verifier (the RPC list is the explicit transaction transport), else
 *  the RPC QuorumChain exactly as before. `clients` (tests) are the RPC/transport peers. */
export function independentChain({ rpcs = [], clients, quorum, confirmations, maxBlockAgeMs, chainVerifier = null, chainId, now, timeoutMs }) {
  const opt = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  if (chainVerifier) return new VerifiedChain(opt({ verifier: chainVerifier, txRpcs: rpcs, txClients: clients, chainId, confirmations, maxBlockAgeMs, now, timeoutMs }));
  return new QuorumChain(opt({ rpcs, clients, quorum, confirmations, maxBlockAgeMs, chainId, now, timeoutMs }));
}
/** A snapshot for TRANSACTION/HISTORY reads (receipts, transactions, nonce counts, logs): the RPC quorum itself in legacy
 *  mode; under the verifier only the explicit transaction transport (receiptSnapshot), never state authority. */
export const historySnapshot = (chain, fn) => (chain.authority === "local-verifier" ? chain.receiptSnapshot(fn) : chain.snapshot(fn));

/** With a reviewed profile: every contract an authority decision uses must carry the reviewed code at the agreed block. */
export async function assertReviewedCode(chain, profile, names) {
  if (!profile) return null;
  const want = names.map((n) => profile.contracts[n]).filter(Boolean);
  const s = await chain.snapshot(async (c, blockNumber) => Promise.all(want.map(async (w) => {
    const code = await c.getCode({ address: w.address, blockNumber });
    return code && code !== "0x" ? keccak256(code) : null;
  })));
  want.forEach((w, i) => {
    if (s.value[i] !== w.codeHash) throw new Error(`${names[i]} at ${w.address} does not carry the reviewed code (${s.value[i] ? "hash " + s.value[i] : "no code"}); refusing`);
  });
  return s;
}

// ---- registry: the DEPLOYED schema 4 ---------------------------------------------------------------------------------
// The live registry 0x868e… is EnclaveRegistry at commit b17db9a3 (schema 4), source-verified in
// contracts/deployments/source-verification-base.json. Source HEAD is schema 5 (caps, region, registerRelay, setCaps):
// none of that exists on the deployed contract, and its 13-field struct does not decode the deployed 11-field one.
export const REGISTRY_SCHEMA4_SOURCE = Object.freeze({ commit: "b17db9a33b3500783a67774f4e47ec648e833699", path: "contracts/EnclaveRegistry.sol",
  gitBlob: "d7fb9740a29cc3d6dc7c197ddf62937112b22a6c", sha256: "e81f5d5185eb83c50f7407e1bda9a71733948fca5eb3b2f228d5e8e598791360" });
const ENCLAVE4 = [["endpoint", "string"], ["repo", "string"], ["measurement", "bytes32"], ["operator", "address"], ["registeredAt", "uint64"],
  ["lastSeen", "uint64"], ["active", "bool"], ["cpuPricePerSec6", "uint64"], ["gpuPricePerSec6", "uint64"], ["proofKey", "address"], ["payoutWallet", "address"]]
  .map(([name, type]) => ({ name, type }));
export const REGISTRY_SCHEMA4_ABI = Object.freeze([
  { type: "function", name: "registrySchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: ENCLAVE4 }] },
  { type: "function", name: "getPage", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "tuple[]", components: ENCLAVE4 }] },
]);
export const REGISTRY_UNSUPPORTED = "the deployed EnclaveRegistry is schema 4 (source b17db9a3, docs/network/deployed-sources.md): it has no capability bits, "
  + "regions, registerRelay or setCaps. Those exist only in the undeployed schema-5 source, so this CLI does not offer them";
const MAX_HOSTS = 4096, PAGE = 50;
const hostRow = (e) => ({ id: keccak256(toBytes(e.endpoint)), endpoint: e.endpoint, repo: e.repo, measurement: e.measurement,
  operator: e.operator.toLowerCase(), registeredAt: Number(e.registeredAt), lastSeen: Number(e.lastSeen), active: e.active,
  cpuPricePerSec6: BigInt(e.cpuPricePerSec6), gpuPricePerSec6: BigInt(e.gpuPricePerSec6), proofKey: e.proofKey.toLowerCase(),
  payoutWallet: e.payoutWallet.toLowerCase() });
/** Throws unless the agreed schema is 4: any other schema has a different struct and would be misread. */
function requireSchema4(schema) {
  if (schema === null) throw new Error("the pinned registry has no registrySchema getter (schema 1); it is not the deployed schema-4 registry");
  if (BigInt(schema) !== 4n) throw new Error(`the pinned registry reports schema ${schema}; this CLI decodes exactly the deployed schema 4 and refuses to guess another struct`);
}
/** Every registered host at one agreed block. -> {hosts, blockNumber, blockHash, timestamp, agreeing, peers} */
export async function registryHosts(chain, registry) {
  const s = await chain.snapshot(async (c, blockNumber) => {
    const r = (fn, args = []) => c.readContract({ address: registry, abi: REGISTRY_SCHEMA4_ABI, functionName: fn, args, blockNumber });
    let schema;
    try { schema = await r("registrySchema"); } catch (e) { if (!isRevert(e)) throw e; schema = null; }
    if (schema === null || BigInt(schema) !== 4n) return { schema };
    const n = await r("count");
    if (n > BigInt(MAX_HOSTS)) return { schema, tooMany: n };
    const rows = [];
    for (let i = 0n; i < n; i += BigInt(PAGE)) {
      const page = await r("getPage", [i, BigInt(PAGE)]);
      if (page.length !== Number(n - i < BigInt(PAGE) ? n - i : BigInt(PAGE))) throw new Error("incomplete registry page");
      rows.push(...page);
    }
    return { schema, rows };
  });
  requireSchema4(s.value.schema);
  if (s.value.tooMany !== undefined) throw new Error(`the registry lists ${s.value.tooMany} hosts, more than the ${MAX_HOSTS} this CLI reads`);
  return { ...s, hosts: s.value.rows.map(hostRow) };
}
/** One host entry (e.g. a lease's runner) in the same snapshot semantics. null = not registered. */
export async function readHost(c, registry, id, blockNumber) {
  let schema;
  try { schema = await c.readContract({ address: registry, abi: REGISTRY_SCHEMA4_ABI, functionName: "registrySchema", blockNumber }); }
  catch (e) { if (!isRevert(e)) throw e; schema = null; }
  if (schema === null || BigInt(schema) !== 4n) return { schema };
  const e = await c.readContract({ address: registry, abi: REGISTRY_SCHEMA4_ABI, functionName: "get", args: [id], blockNumber });
  return { schema, host: /^0x0{40}$/i.test(e.operator) ? null : hostRow(e) };
}
export { requireSchema4 };

/** Hosts the registry ADMITS for new work at the agreed block: active and posting a CPU price. Admission, not liveness. */
export function admittedHosts(hosts) { return hosts.filter((h) => h.active === true && h.cpuPricePerSec6 > 0n); }
/**
 * Live hosts: admitted (above) AND live by network/host-liveness.mjs at the agreed block time. A host is live on an
 * unexpired operator-signed capacity record the caller VERIFIED (signedUntil: Map(hostId -> expiresAt ms), from
 * cli/independent-capacity.mjs readCapacity), or on its operator's own registry write within the window. Nothing
 * sends that write periodically any more: a host that serves no record and changed nothing for an hour is not live.
 * Each host gets its `liveness`. -> the live ones
 */
export function liveHosts(hosts, blockTimeMs, { signedUntil = null, nowMs = Date.now(), registryUpdateWindowSec = REGISTRY_UPDATE_WINDOW_SEC } = {}) {
  return withLiveness(admittedHosts(hosts), blockTimeMs, { signedUntil, nowMs, registryUpdateWindowSec }).filter((h) => h.liveness.live);
}
/**
 * Signed liveness evidence for the admitted hosts of ONE agreed registry snapshot `reg` (registryHosts): each host's own
 * operator-signed capacity record, fetched from its registered endpoint (https, public addresses only, no redirects:
 * network/host-capacity-http.mjs publicJsonFetch) and verified against THAT host's row in `reg` and the explicitly
 * selected registry (network/host-capacity.mjs verifyHostCapacity: signer = the row's operator, its exact endpoint and
 * hostId, this chain and registry, the row active, unexpired by the reader's clock). The binding is the authority the
 * snapshot came from, so it works with --contract-pins alone; it claims no reviewed code hash (a profile's code pin is
 * checked separately, by assertReviewedCode). Bounded: at most maxHosts fetches, `concurrency` at a time, each timed out.
 * Hosts beyond maxHosts are NOT checked and are listed as such (`unchecked`), never as failures: a caller must say the
 * evidence is incomplete rather than treat them as down.
 * -> { signedUntil: Map(hostId -> expiresAt ms), failures: Map(hostId -> reason), unchecked: [hostId], admitted: n }
 */
export async function signedLiveness(reg, { registry, chainId = BASE_CHAIN_ID, fetchHost = null, concurrency = 8, maxHosts = 256, now = Date.now } = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(registry || ""))) throw new Error("signedLiveness needs the selected registry address");
  const { verifyHostCapacity } = await import("../network/host-capacity.mjs");
  const H = await import("../network/host-capacity-http.mjs");
  const get = fetchHost || H.publicJsonFetch();
  const admitted = admittedHosts(reg.hosts), queue = admitted.slice(0, maxHosts), signedUntil = new Map(), failures = new Map();
  const unchecked = admitted.slice(maxHosts).map((h) => h.id);
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let h; (h = queue.shift());) {
      try {
        const r = await get(h.endpoint.replace(/\/+$/, "") + H.HOST_CAPACITY_PATH);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const v = await verifyHostCapacity(r.json, { pins: { chainId, registry }, entry: { endpoint: h.endpoint, operator: h.operator, active: h.active }, now: now() });
        signedUntil.set(h.id, v.record.expiresAt);
      } catch (e) { failures.set(h.id, String(e.message).slice(0, 160)); }
    }
  }));
  return { signedUntil, failures, unchecked, admitted: admitted.length };
}
/** Every host with its `liveness` (inactive and unpriced rows included, judged by the same rule). */
export function withLiveness(hosts, blockTimeMs, { signedUntil = null, nowMs = Date.now(), registryUpdateWindowSec = REGISTRY_UPDATE_WINDOW_SEC } = {}) {
  const chainNowSec = Math.floor(blockTimeMs / 1000);
  return hosts.map((h) => ({ ...h, liveness: hostLiveness(h, { nowMs, chainNowSec, signedUntilMs: signedUntil?.get(h.id) ?? null, registryUpdateWindowSec }) }));
}
/** The cheapest posted prices among live hosts (the box a new deployment would land on). gpu6 is null when no live
 *  host sells a card. null = no live host at all. */
export function cheapestPrices(hosts) {
  if (!hosts.length) return null;
  const min = (xs) => xs.reduce((m, x) => (x < m ? x : m), xs[0]);
  const cards = hosts.filter((h) => h.gpuPricePerSec6 > 0n).map((h) => h.gpuPricePerSec6);
  return { cpu6: min(hosts.map((h) => h.cpuPricePerSec6)), gpu6: cards.length ? min(cards) : null, hosts: hosts.length };
}

// ---- ledger --------------------------------------------------------------------------------------------------------
const MAX_RECORDS = 10000, LEDGER_PAGE = 100;
/** Every record held by one of `owners`, from count()/getPage() at one agreed block. abi: the CLI's schema-matched ABI. */
export async function ledgerRecords(chain, { deployments, abi, owners }) {
  const want = new Set(owners.map((o) => o.toLowerCase()));
  const s = await chain.snapshot(async (c, blockNumber) => {
    const n = await c.readContract({ address: deployments, abi, functionName: "count", blockNumber });
    if (n > BigInt(MAX_RECORDS)) return { tooMany: n };
    const rows = [];
    for (let i = 0n; i < n; i += BigInt(LEDGER_PAGE)) {
      const page = await c.readContract({ address: deployments, abi, functionName: "getPage", args: [i, BigInt(LEDGER_PAGE)], blockNumber });
      if (page.length !== Number(n - i < BigInt(LEDGER_PAGE) ? n - i : BigInt(LEDGER_PAGE))) throw new Error("incomplete ledger page");
      rows.push(...page.filter((d) => want.has(d.owner.toLowerCase())));
    }
    return { count: n, rows };
  });
  if (s.value.tooMany !== undefined) throw new Error(`the ledger holds ${s.value.tooMany} records, more than the ${MAX_RECORDS} this CLI enumerates`);
  return { ...s, total: s.value.count, rows: s.value.rows };
}

/** status <id>: the record, its cap, fee, proof state and (when leased) its runner's registry entry, at ONE block. */
export async function deploymentSnapshot(chain, { deployments, registry, abi, rev, id }) {
  const s = await chain.snapshot(async (c, blockNumber) => {
    const r = (fn, args = [], optional = false) => c.readContract({ address: deployments, abi, functionName: fn, args, blockNumber })
      .catch((e) => { if (optional && isRevert(e)) return null; throw e; });
    const d = await r("get", [id]);
    if (/^0x0{40}$/i.test(d.owner)) return { exists: false };
    const [cap6, fee, proven, proofRequired] = await Promise.all([
      rev >= 8 ? r("capOf", [id], true) : null, rev >= 4 ? r("feeOf", [id], true) : null,
      rev >= 9 ? r("provenUntil", [id], true) : null, rev >= 9 ? r("proofRequired", [], true) : null]);
    const leased = !/^0x0{64}$/i.test(d.runner) && d.leaseUntil > 0n;
    const runner = leased ? await readHost(c, registry, d.runner, blockNumber) : null;
    return { exists: true, d, cap6, fee, proven, proofRequired, runner };
  });
  if (s.value.runner && s.value.runner.schema !== undefined) requireSchema4(s.value.runner.schema);
  return s;
}

// ---- sessions ------------------------------------------------------------------------------------------------------
const SESSION_TUPLE = [["keyHash", "bytes32"], ["measurement", "bytes32"], ["actions", "uint256"], ["expiresAt", "uint64"], ["epoch", "uint64"],
  ["envs", "uint8"], ["state", "uint8"], ["anyApp", "bool"], ["balance6", "uint128"], ["spent6", "uint128"], ["perPeriod6", "uint128"],
  ["maxFee6", "uint128"], ["maxAppFeeHour6", "uint128"], ["maxRateHour6", "uint128"], ["periodStart", "uint64"], ["period", "uint32"],
  ["opsPerPeriod", "uint32"], ["periodSpent6", "uint128"], ["periodOps", "uint32"]].map(([name, type]) => ({ name, type }));
const VAULT_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "epoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "sessionOf", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [{ type: "tuple", components: SESSION_TUPLE }, { type: "bool" }, { type: "bytes32[]" }] },
];
const FACTORY_ABI = [
  { type: "function", name: "isVault", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "vaultFor", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
];
/** The vault a wallet's sessions live in on the pinned factory, and whether it exists, at one agreed block. */
export async function vaultOf(chain, factory, owner) {
  const s = await chain.snapshot(async (c, blockNumber) => {
    const vault = await c.readContract({ address: factory, abi: FACTORY_ABI, functionName: "vaultFor", args: [owner], blockNumber });
    const code = await c.getCode({ address: vault, blockNumber });
    return { vault: vault.toLowerCase(), deployed: !!code && code !== "0x" };
  });
  return s.value;
}
/** A session as the chain holds it, on the PINNED factory. Never asks the relay. */
export async function sessionSnapshot(chain, { factory, vault, sid }) {
  const s = await chain.snapshot(async (c, blockNumber) => {
    const isVault = await c.readContract({ address: factory, abi: FACTORY_ABI, functionName: "isVault", args: [vault], blockNumber });
    if (!isVault) return { isVault: false };
    const v = (fn, args = []) => c.readContract({ address: vault, abi: VAULT_ABI, functionName: fn, args, blockNumber });
    const [owner, vf, epoch, [session, live, apps]] = await Promise.all([v("owner"), v("factory"), v("epoch"), v("sessionOf", [sid])]);
    return { isVault: true, owner: owner.toLowerCase(), factory: vf.toLowerCase(), epoch, session, live, apps };
  });
  const x = s.value;
  if (!x.isVault) throw new Error(`${vault} is not a vault of the pinned session factory ${factory}`);
  if (x.factory !== factory.toLowerCase()) throw new Error(`vault ${vault} names factory ${x.factory}, not the pinned ${factory}`);
  return { ...s, ...x, exists: !/^0x0{64}$/i.test(x.session.keyHash) };
}
export const hasAction = (actions, bit) => ((BigInt(actions) >> BigInt(bit)) & 1n) === 1n;

// ---- transactions --------------------------------------------------------------------------------------------------
export class OutcomeUnknownError extends Error {
  constructor(hash, why) {
    super(`transaction ${hash} was broadcast but ${why}; its outcome is UNKNOWN. Do not resend or re-sign it: check the ledger `
      + `(enclave status) first. Re-broadcasting these same signed bytes is the only safe repeat.`);
    this.name = "OutcomeUnknownError"; this.hash = hash; this.outcomeUnknown = true;
  }
}
const definiteRejection = (msg) => /insufficient funds|intrinsic gas|exceeds block gas|invalid sender|invalid signature|transaction type not supported|max fee per gas less than block base fee|fee cap|gas limit reached/i.test(msg);
const receiptView = (r) => ({ status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash, transactionHash: r.transactionHash,
  contractAddress: r.contractAddress ?? null, gasUsed: r.gasUsed,
  logs: (r.logs || []).map((l) => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data, logIndex: l.logIndex })) });

/**
 * Sign once, broadcast the same bytes to every RPC, confirm by quorum. A local private-key account is required (the
 * signed bytes, and so the hash, are known before anything leaves this process).
 * -> the agreed receipt (status success), or throws: a definite refusal (nothing pending) or OutcomeUnknownError.
 */
// confirm (optional, verifier mode): async (chain) => boolean - the intended effect, read through verified state after the send
export async function sendQuorumTx(chain, { account, to, data, value = 0n, maxFeeGwei = 5, gasCap = 15_000_000n, timeoutMs = 180000, pollMs = 1000, log = () => {}, confirm = null }) {
  // an external signer (cli/independent-signer.mjs) runs this same preparation and broadcast with its wallet as the signer
  if (typeof account?.sendQuorumTx === "function") return account.sendQuorumTx(chain, { to, data, value, maxFeeGwei, gasCap, timeoutMs, pollMs, log, confirm });
  if (typeof account?.signTransaction !== "function") throw new Error("independent mode signs with the wallet key (ENCLAVE_KEY or the key file), an external signer (--signer URL --from 0x…) or --unsigned");
  const from = account.address;
  // 1. the call must succeed at an agreed block (preconditions, as the ledger itself judges them)
  const sim = await chain.snapshot(async (c, blockNumber) => {
    try { await c.call({ account: from, to, data, value, blockNumber }); return { ok: true }; }
    catch (e) { if (isRevert(e)) return { revert: revertReason(e) }; throw e; }
  });
  if (sim.value.revert !== undefined) throw new Error(`refusing to send: the transaction would revert at agreed block ${sim.blockNumber} (${sim.value.revert || "no reason"})`);
  // 2. one pending nonce, the same on every answering RPC: disagreement means something from this wallet is in flight
  const nonces = await chain.each((c) => c.getTransactionCount({ address: from, blockTag: "pending" }), "pending nonce");
  if (new Set(nonces.map(String)).size !== 1) throw new Error(`refusing to send: the RPCs disagree on this wallet's pending nonce (${[...new Set(nonces.map(String))].join(", ")}); a transaction may be in flight - wait and check status`);
  const nonce = Number(nonces[0]);
  // under the verifier the transport's pending nonce must not be one verified state already shows used: then a nonce later
  // seen consumed can only have been used by a transaction this account signed after now (the transport cannot sign)
  if (chain.authority === "local-verifier") await chain.assertNonceUnused(from, nonce);
  // 3. gas and fees: the highest estimate, bounded
  const gases = await chain.each((c) => c.estimateGas({ account: from, to, data, value }), "gas estimate");
  let gas = gases.reduce((m, g) => (g > m ? g : m), 0n); gas = gas + gas / 5n;
  if (gas > gasCap) throw new Error(`refusing to send: gas estimate ${gas} is above the ${gasCap} cap`);
  const fees = await chain.each((c) => c.estimateFeesPerGas(), "fee estimate");
  const maxFeePerGas = fees.reduce((m, f) => (f.maxFeePerGas > m ? f.maxFeePerGas : m), 0n) || 1n;
  const maxPriorityFeePerGas = fees.reduce((m, f) => (f.maxPriorityFeePerGas > m ? f.maxPriorityFeePerGas : m), 0n);
  const capWei = BigInt(Math.round(Number(maxFeeGwei) * 1e9));
  if (maxFeePerGas > capWei) throw new Error(`refusing to send: max fee ${maxFeePerGas} wei/gas is above --max-fee-gwei ${maxFeeGwei}`);
  // 4. sign once
  const raw = await account.signTransaction({ type: "eip1559", chainId: chain.chainId, nonce, to, data, value, gas, maxFeePerGas,
    maxPriorityFeePerGas: maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : maxPriorityFeePerGas });
  const hash = keccak256(raw);
  log(`signed ${hash} (nonce ${nonce}); broadcasting the same bytes to ${chain.peers.length} RPCs`);
  // 5. broadcast the identical bytes everywhere
  const sent = await Promise.allSettled(chain.peers.map(({ client }) => client.request({ method: "eth_sendRawTransaction", params: [raw] })));
  let accepted = 0, rejected = 0;
  const reasons = [];
  sent.forEach((r, i) => {
    if (r.status === "fulfilled" && String(r.value).toLowerCase() === hash.toLowerCase()) return accepted++;
    const msg = r.status === "fulfilled" ? `answered ${String(r.value).slice(0, 20)}` : short(r.reason);
    if (/already known|known transaction/i.test(msg)) return accepted++;
    if (r.status === "rejected" && definiteRejection(msg)) rejected++;
    reasons.push(`${chain.host(i)}: ${msg}`);
  });
  if (!accepted && rejected === chain.peers.length)
    throw new Error(`no RPC accepted the transaction, nothing is pending (${reasons.slice(0, 4).join("; ")})`);
  if (!accepted) throw new OutcomeUnknownError(hash, `no RPC confirmed accepting it (${reasons.slice(0, 4).join("; ")})`);
  // 6. the receipt, as a quorum sees it in a confirmed block
  const deadline = Date.now() + timeoutMs;
  let last = "no quorum yet";
  while (Date.now() < deadline) {
    try {
      const s = await historySnapshot(chain, async (c, blockNumber) => {
        let r;
        try { r = await c.getTransactionReceipt({ hash }); } catch (e) { if (/not.?found|could not be found/i.test(short(e)) || e?.name === "TransactionReceiptNotFoundError") return { pending: true }; throw e; }
        if (!r || r.blockNumber > blockNumber) return { pending: true };
        if ((await c.getBlock({ blockNumber: r.blockNumber })).hash !== r.blockHash) return { pending: true };
        return { receipt: receiptView(r) };
      });
      if (s.value.receipt) {
        const ok = s.value.receipt.status === "success";
        // under the verifier the receipt comes from the explicit transport: not state authority. Before ANY verdict (success
        // or revert) the verifier must reach its block and show the nonce consumed (verifyOutcome), so a transport cannot
        // end a send with a fabricated receipt, and every later read sees at least that state (callers read effects back)
        const evidence = chain.authority === "local-verifier"
          ? await chain.verifyOutcome({ hash, from, nonce, receiptBlock: s.value.receipt.blockNumber, confirm: ok ? confirm : null, timeoutMs: Math.max(1000, deadline - Date.now()), pollMs })
          : null;
        if (!ok) throw Object.assign(new Error(`transaction reverted: ${hash} (block ${s.value.receipt.blockNumber})${evidence
          ? `; the revert is reported by the explicit transport (UNVERIFIED); nonce ${nonce} IS consumed in verified state at block ${evidence.postStateBlock}` : ""}`), { mined: true, ...(evidence ? { evidence } : {}) });
        if (evidence) return { ...s.value.receipt, agreedBlock: evidence.postStateBlock, agreeing: s.agreeing, stateVerified: evidence.stateVerified, evidence };
        return { ...s.value.receipt, agreedBlock: s.blockNumber, agreeing: s.agreeing };
      }
      last = "not yet confirmed";
    } catch (e) { if (e.mined || e.final) throw e; last = short(e); }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new OutcomeUnknownError(hash, `no RPC quorum confirmed it within ${Math.round(timeoutMs / 1000)}s (${last})`);
}
/** How a send's receipt may be described: the RPC quorum's agreement, or under the verifier exactly what is verified
 *  (the nonce consumed in verified state, the effect only where checked) and that the transport's receipt is NOT proof. */
export function receiptLine(r) {
  if (!r?.evidence) return `confirmed by ${r?.agreeing} RPCs`;
  return `nonce consumed in verified state at block ${r.evidence.postStateBlock}; effect ${r.evidence.effect}; the transport's receipt is UNVERIFIED (inclusion and status not proven)`;
}
/** sendTx-shaped adapter for the CLI. */
export function quorumWriter(chain, opts) {
  return (account, { address, abi, functionName, args, value }) =>
    sendQuorumTx(chain, { ...opts, account, to: address, data: encodeFunctionData({ abi, functionName, args }), value: value || 0n });
}
/**
 * A viem-PublicClient-shaped view of the quorum, for SDK helpers that take a `publicClient` (sessions: prepareCall,
 * prepareSessionOpen, prepareOwnerOperation, prepareTopUpFromWallet, delegationStatus). Every call they make is
 * answered by `quorum` agreeing RPCs at one confirmed block; the SDK never sees a single RPC.
 */
export function quorumPublicClient(chain) {
  return {
    chain: { id: chain.chainId },
    getChainId: async () => chain.chainId,                                  // every snapshot already checks it per peer
    getBlock: async () => {
      const s = await chain.snapshot(async (c, blockNumber) => ({ timestamp: (await c.getBlock({ blockNumber })).timestamp }));
      return { number: s.blockNumber, hash: s.blockHash, timestamp: s.value.timestamp };
    },
    getBlockNumber: async () => (await chain.snapshot(async () => 0)).blockNumber,
    readContract: ({ address, abi, functionName, args = [] }) => chain.read(address, abi, functionName, args),
    getCode: ({ address }) => chain.snapshot((c, blockNumber) => c.getCode({ address, blockNumber })).then((s) => s.value),
    getStorageAt: ({ address, slot }) => chain.snapshot((c, blockNumber) => c.getStorageAt({ address, slot, blockNumber })).then((s) => s.value),
    getBalance: ({ address }) => chain.balance(address),
  };
}
/** The quorum's peers for network/lease-reader.mjs, unchanged: that reader counts each viem client by its transport URL
 *  under the same shared identity rule (network/rpc-identity.mjs) these origins were validated with. */
export function leaseReaderClients(chain) {
  // under --chain-verifier the peers are the explicit TRANSACTION transport (untrusted for state): a consumer that builds
  // its own quorum reader from them (custody v2: cli/custody-independent.mjs, mcp/independent-secrets.mjs) refuses instead
  if (chain.authority === "local-verifier") throw Object.assign(new Error("custody reads have their own quorum interface (custody/v2) and are not available under --chain-verifier; run custody commands without it"), { code: "chain_unsupported" });
  return chain.peers.map(({ client }) => client);
}
/** The clients + majority custody v2's own quorum reader (custody/v2/chain.mjs createChainReaderV2) takes: the RPC quorum's
 *  peers, or under --chain-verifier ONE verifier-backed client (network/verified-chain.mjs verifierClient: proof-backed state
 *  at a block hash only) with minAgree 1 - custody keeps its own confirmations, freshness and re-check rules, and never
 *  reads the transaction transport. */
export function custodyChainClients(chain, trust) {
  if (chain.authority === "local-verifier") return { clients: [verifierClient(chain.verifier, { chainId: chain.chainId })], minAgree: 1, authority: "local-verifier" };
  const clients = leaseReaderClients(chain);
  return { clients, minAgree: Math.max(trust.quorum, Math.floor(clients.length / 2) + 1), authority: "provider-quorum" };
}
/** LeaseReader authority options for independent mode: the local verifier when --chain-verifier is set, else the quorum's clients. */
export function independentReaderAuthority(trust, chain) {
  return trust.chainVerifier ? { authority: "verifier", verifier: trust.chainVerifier } : { clients: leaseReaderClients(chain) };
}
export { ZERO };
