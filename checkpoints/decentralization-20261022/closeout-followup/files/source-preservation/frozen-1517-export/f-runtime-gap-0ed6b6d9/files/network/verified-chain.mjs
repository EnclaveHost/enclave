// One proof-backed snapshot of chain state at ONE block, from the LOCAL validating verifier (the patched Helios, branch
// enclave-base-evm: it follows a sequencer-signed Base head and answers reads from proofs verified against that
// block's state root, executing calls with the maintained Base EVM). Shared by the independent policy readers that do
// not go through LeaseReader: the service index (network/service-index.mjs readServiceIndex: discovery and cold
// bootstrap) and the platform host policy runtime (network/host-policy-runtime.mjs: admin admission policy).
//
// What a snapshot proves: every value was proven against the state root of the block the verifier holds for its
// signed head chain - the sequencer-signed UNSAFE tier, no L1 finality. It is never one vote of a provider quorum, and a
// caller that chose this authority has no provider fallback: a failed proof, a missing witness, a stale or reorganized
// head all refuse.
//
// One deadline bounds the WHOLE operation, including the caller's read callback; when the snapshot settles (answer,
// refusal or deadline) its pinned client stops working, so a retained client cannot keep reading.
// (LeaseReader carries its own copy of this logic at 921d60c2b; worker B owns the whole-operation deadline fix there.
//  The two are to be unified by root when B's fix composes.)
import { encodeFunctionData, decodeFunctionResult, createPublicClient, custom } from 'viem';
import { rpcEndpoint } from './rpc-identity.mjs';

const lc = (s) => String(s).toLowerCase();
const HASH = /^0x[0-9a-fA-F]{64}$/;
// the error codes custody/v2/quorum.mjs gives the same failures, so callers that classify them see the same classes
const fail = (code, message, cause) => Object.assign(new Error(message), { code, status: 503, ...(cause ? { cause } : {}) });
const hexBlock = (b) => '0x' + b.toString(16);

/**
 * The verifier endpoint: a loopback JSON-RPC URL, or in-process an object with request(method, params, timeoutMs). A
 * remote URL is refused: a remote "verifier" is one unverified server.
 */
export function verifierEndpoint(v) {
  if (v && typeof v === 'object' && typeof v.request === 'function') return { request: (m, p, ms, signal) => v.request(m, p, ms, signal), label: 'verifier' };
  const url = typeof v === 'string' ? v : v?.url;
  let e; try { e = rpcEndpoint(url); } catch (err) { throw new Error('verifier endpoint: ' + err.message); }
  if (!e.loopback) throw new Error('the verifier must be a local endpoint (loopback); a remote server is not a verifier');
  let id = 0;
  return { label: 'verifier ' + e.label, request: async (method, params, ms, signal) => {
    const timeout = AbortSignal.timeout(Math.max(1, ms));
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!r.ok) throw Object.assign(new Error(`verifier HTTP ${r.status}`), { status: r.status });
    const j = await r.json();
    if (j?.error) throw Object.assign(new Error('verifier: ' + String(j.error.message || 'error').slice(0, 300)), { rpcCode: j.error.code });
    return j?.result;
  } };
}

/** The verifier's block `b`: that number, a 32-byte hash and state root, a whole-second timestamp -> {number, hash, stateRoot, timestamp ms}. */
export function verifiedHeader(block, b) {
  if (!block || typeof block !== 'object') throw fail('chain_unconfirmed', 'the verifier has no block ' + b);
  let number; try { number = BigInt(block.number); } catch { throw fail('chain_unconfirmed', 'malformed verified block number'); }
  if (number !== b) throw fail('chain_unconfirmed', 'verified block number differs from the one requested');
  if (!HASH.test(block.hash || '') || !HASH.test(block.stateRoot || '')) throw fail('chain_unconfirmed', 'malformed verified block hash or state root');
  let ts; try { ts = Number(BigInt(block.timestamp)) * 1000; } catch { throw fail('chain_unconfirmed', 'malformed verified block timestamp'); }
  if (!Number.isSafeInteger(ts) || ts < 0) throw fail('chain_unconfirmed', 'malformed verified block timestamp');
  return { number: b, hash: lc(block.hash), stateRoot: lc(block.stateRoot), timestamp: ts };
}

export const PINNED_METHODS = Object.freeze(['getChainId', 'getBlockNumber', 'getBlock', 'readContract', 'getCode', 'getBytecode', 'getStorageAt', 'getBalance']);
/** The only client a read callback sees: every answer at block `b` (by hash), proof-backed; anything else refuses by name.
 *  allowCall: also a raw `call` ({account, to, data, value}) - the same proof-backed eth_call at `b`, for simulating a
 *  transaction's preconditions (off unless a snapshot function is created with allowCall). */
export function pinnedClient({ b, hash, request, chainId, alive = () => {}, allowCall = false }) {
  const at = (blockNumber, blockTag) => {
    if (blockTag !== undefined) throw new Error(`verified reads are pinned to block ${b} (no block tags)`);
    if (blockNumber !== undefined && BigInt(blockNumber) !== b) throw new Error(`verified reads are pinned to block ${b}`);
    return { blockHash: hash };
  };
  const code = async ({ address, blockNumber, blockTag }) => { const c = await request('eth_getCode', [address, at(blockNumber, blockTag)]); return c && c !== '0x' ? c : undefined; };
  const methods = {
    getChainId: async () => chainId,
    getBlockNumber: async () => b,
    getBlock: async ({ blockNumber, blockTag, blockHash } = {}) => {
      if (blockHash !== undefined && lc(blockHash) !== hash) throw new Error(`verified reads are pinned to block ${b}`);
      at(blockNumber, blockTag);
      const h = verifiedHeader(await request('eth_getBlockByNumber', [hexBlock(b), false]), b);
      if (h.hash !== hash) throw fail('chain_unconfirmed', 'chain reorganized during the read');
      return { number: b, hash: h.hash, stateRoot: h.stateRoot, timestamp: BigInt(h.timestamp / 1000) };
    },
    readContract: async ({ address, abi, functionName, args, blockNumber, blockTag, account }) => {
      const data = encodeFunctionData({ abi, functionName, args });
      const from = typeof account === 'string' ? account : account?.address;
      return decodeFunctionResult({ abi, functionName, data: await request('eth_call', [{ to: address, data, ...(from ? { from } : {}) }, at(blockNumber, blockTag)]) });
    },
    getCode: code, getBytecode: code,
    getStorageAt: async ({ address, slot, blockNumber, blockTag }) => request('eth_getStorageAt', [address, slot, at(blockNumber, blockTag)]),
    getBalance: async ({ address, blockNumber, blockTag }) => BigInt(await request('eth_getBalance', [address, at(blockNumber, blockTag)])),
    ...(allowCall ? { call: async ({ account, to, data, value, blockNumber, blockTag }) => {
      const from = typeof account === 'string' ? account : account?.address;
      const tx = { to, ...(data ? { data } : {}), ...(from ? { from } : {}), ...(value ? { value: '0x' + BigInt(value).toString(16) } : {}) };
      return { data: await request('eth_call', [tx, at(blockNumber, blockTag)]) };
    } } : {}),
  };
  return new Proxy(Object.freeze({}), { get(_t, key) {
    if (Object.hasOwn(methods, key)) return async (...args) => { alive(); return methods[key](...args); };
    if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return undefined;
    return () => { throw new Error(`client.${String(key)} is not available under the verifier authority (proof-backed reads only: ${PINNED_METHODS.join(', ')})`); };
  } });
}

/**
 * A snapshot function for one verifier: snapshot(read, {atBlock}) -> {blockNumber, blockHash, stateRoot, timestamp (ms),
 * value, evidence}. read(client, blockNumber, header) gets the pinned client.
 *   * block: the verifier head minus `confirmations`, never below a block this snapshot function accepted and refused if
 *     the verifier head goes behind it; `atBlock` {number, hash} resumes exactly that block (pagination) and refuses if its
 *     hash is no longer the verifier's;
 *   * freshness: the block timestamp neither older than `maxBlockAgeMs` nor more than `futureSkewMs` ahead, before and after
 *     the read (a resumed block too: history never counts as fresh authority);
 *   * the header is read again after the callback (same hash and timestamp, else reorganized);
 *   * one `deadlineMs` bounds the whole operation including the callback; afterwards the pinned client refuses.
 */
export function createVerifiedSnapshot({ verifier, chainId, confirmations = 2, maxBlockAgeMs = 90_000, futureSkewMs = 5_000, deadlineMs = 30_000, now = Date.now, allowCall = false } = {}) {
  const v = verifierEndpoint(verifier);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('chain id required');
  const int = (x, lo, hi) => Number.isSafeInteger(x) && x >= lo && x <= hi;
  if (!int(confirmations, 0, 64) || !int(maxBlockAgeMs, 1000, 600_000) || !int(futureSkewMs, 0, 60_000) || !int(deadlineMs, 100, 300_000) || typeof now !== 'function')
    throw new Error('invalid verified snapshot policy');
  let floor = null;                                    // {number, hash} of the newest block this function accepted
  return async function snapshot(read, { atBlock = null } = {}) {
    if (typeof read !== 'function') throw new Error('snapshot(read) needs a read function');
    if (atBlock && !HASH.test(String(atBlock.hash))) throw new Error('resume block hash required');
    let closed = false, timer;
    const controller = new AbortController();
    const endAt = performance.now() + deadlineMs;
    const alive = () => {
      if (closed) throw fail('chain_closed', 'this verified snapshot has already ended');
      const left = Math.floor(endAt - performance.now());
      if (left <= 0) throw fail('chain_timeout', 'the verified read deadline has passed');
      return left;
    };
    const request = async (method, params) => {
      const value = await v.request(method, params, alive(), controller.signal);
      // A custom transport may ignore cancellation. Its late answer must not advance the accepted-block floor.
      alive();
      return value;
    };
    const fresh = (ts) => ts + maxBlockAgeMs > now();
    const work = (async () => {
      const id = Number(BigInt(await request('eth_chainId', [])));
      if (id !== chainId) throw fail('chain_wrong_network', `the verifier follows chain ${id}, not ${chainId}`);
      let b;
      if (atBlock) b = BigInt(atBlock.number);
      else {
        const head = BigInt(await request('eth_blockNumber', []));   // Helios refuses a head older than 60 s
        if (floor && head < floor.number) throw fail('chain_rollback', `the verifier head ${head} is behind block ${floor.number} already accepted`);
        b = head - BigInt(confirmations);
        if (b < 0n) throw fail('chain_unconfirmed', 'no confirmed block yet');
        if (floor && b < floor.number) b = floor.number;
      }
      const h = verifiedHeader(await request('eth_getBlockByNumber', [hexBlock(b), false]), b);
      if (atBlock && h.hash !== lc(atBlock.hash)) throw fail('chain_reorg', 'the resume block is no longer canonical');
      if (floor && b === floor.number && h.hash !== floor.hash) throw fail('chain_rollback', 'the accepted block was replaced');
      if (h.timestamp > now() + futureSkewMs) throw fail('chain_future', 'the verified block is in the future');
      if (!fresh(h.timestamp)) throw fail('chain_stale', `verified block ${b} is older than ${maxBlockAgeMs} ms`);
      const value = await read(pinnedClient({ b, hash: h.hash, request, chainId, alive, allowCall }), b, h);
      const again = verifiedHeader(await request('eth_getBlockByNumber', [hexBlock(b), false]), b);
      if (again.hash !== h.hash || again.timestamp !== h.timestamp) throw fail('chain_reorg', 'chain reorganized during the read');
      if (!fresh(h.timestamp)) throw fail('chain_stale', `verified block ${b} became older than ${maxBlockAgeMs} ms during the read`);
      if (floor && b < floor.number) throw fail('chain_rollback', `block ${b} is older than block ${floor.number} accepted meanwhile`);
      alive();
      if (!floor || b > floor.number) floor = { number: b, hash: h.hash };
      return { blockNumber: b, blockHash: h.hash, stateRoot: h.stateRoot, timestamp: h.timestamp, value,
        evidence: { authority: 'local-verifier', tier: 'unsafe', finality: 'none', blockNumber: String(b), blockHash: h.hash, stateRoot: h.stateRoot, verifier: v.label } };
    })();
    // a REFERENCED timer (always cleared on settlement): an unref'd one would let a hung read outlive the event loop unsettled
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(fail('chain_timeout', `no verified snapshot within ${deadlineMs} ms`)), deadlineMs); });
    try { return await Promise.race([work, deadline]); }
    catch (e) { throw e?.code ? e : fail('chain_unconfirmed', 'no verified chain state: ' + String(e?.message || e).slice(0, 300), e); }
    finally { closed = true; clearTimeout(timer); controller.abort(fail('chain_closed', 'this verified snapshot has already ended')); work.catch(() => {}); }
  };
}

/**
 * The explicit authority choice shared by config surfaces: ({chainAuthority, chainVerifier}) -> null (the legacy
 * provider quorum) or the verifier URL. A verifier without chainAuthority 'verifier' is refused as ambiguous.
 */
export function chainVerifierOf({ chainAuthority, chainVerifier } = {}, what = 'chain authority') {
  if (chainAuthority === undefined || chainAuthority === null || chainAuthority === '' || chainAuthority === 'quorum') {
    if (chainVerifier !== undefined && chainVerifier !== null && chainVerifier !== '') throw new Error(`${what}: a verifier is set but the chain authority is not verifier`);
    return null;
  }
  if (chainAuthority !== 'verifier') throw new Error(`${what}: chainAuthority must be quorum or verifier`);
  if (!chainVerifier) throw new Error(`${what}: chainAuthority verifier needs chainVerifier (the local verifier URL)`);
  verifierEndpoint(chainVerifier);                     // local only, refused now rather than at first use
  return chainVerifier;
}

// ---- the same authority as a viem client, for readers that run their OWN agreement/freshness rules ------------------------
// custody v2's createQuorumReader (custody/v2/quorum.mjs) and the credit-vault reader take viem-shaped clients and apply
// their own confirmations, freshness, header re-check and rollback checkpoint. This client is that reader's ONE input under
// the explicit verifier: every request goes to the local (loopback) verifier, state methods only at an explicit block HASH
// (no tags, so nothing reads unpinned state), headers only by number; anything else refuses by name. It never contacts a
// provider and has nothing to fall back to.
const PINNED_STATE_RPC = new Set(['eth_call', 'eth_getCode', 'eth_getStorageAt', 'eth_getBalance', 'eth_getTransactionCount']);
const QTY = /^0x(0|[1-9a-f][0-9a-f]*)$/i;
/** -> request(method, params, timeoutMs) over the verifier, validating every request as above. */
export function verifierRequest(verifier) {
  const v = verifierEndpoint(verifier);
  return async (method, params = [], timeoutMs = 15_000) => {
    if (method === 'eth_chainId' || method === 'eth_blockNumber') return v.request(method, [], timeoutMs);
    if (method === 'eth_getBlockByNumber') {
      if (!QTY.test(String(params[0])) || params[1] !== false) throw fail('chain_unsupported', 'verified headers are read by block number, without transactions');
      return v.request(method, [params[0], false], timeoutMs);
    }
    if (PINNED_STATE_RPC.has(method)) {
      const at = params[params.length - 1];
      if (!at || typeof at !== 'object' || !HASH.test(String(at.blockHash || ''))) throw fail('chain_unsupported', `${method}: verified state is read only at an explicit block hash`);
      return v.request(method, [...params.slice(0, -1), { blockHash: lc(at.blockHash) }], timeoutMs);
    }
    throw fail('chain_unsupported', `${method} is not served by the local verifier authority (proof-backed state at a block hash, and headers, only)`);
  };
}
/** A viem public client over verifierRequest (custom transport, no retries): for custody v2 / credit-vault readers. */
export function verifierClient(verifier, { chainId = 8453, timeoutMs = 15_000 } = {}) {
  const request = verifierRequest(verifier);
  return createPublicClient({ chain: { id: chainId, name: 'verified', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } },
    transport: custom({ request: ({ method, params }) => request(method, params || [], timeoutMs) }, { retryCount: 0 }) });
}
