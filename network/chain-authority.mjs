// The host's chain authority when its operator EXPLICITLY selected the local verifier (ENCLAVE_CHAIN_AUTHORITY=verifier,
// ENCLAVE_CHAIN_VERIFIER=<loopback URL>), for consumers that speak JSON-RPC through viem (supervisor.js's chainClient and
// operator wallet, the lease-gas and owner-nomination readers through client/lease-executor-authority.mjs).
//
// Every method is routed by name to exactly one place, with the trust it actually has (METHODS below):
//   * the LOCAL VERIFIER (the patched Helios behind network/rpc-runtime.mjs): state is executed or proven against the state
//     root of a block on its sequencer-signed head chain (the UNSAFE tier; no L1 finality), receipts are checked against
//     the block's receipts root, a log is checked against its block's receipts. A log the sources leave out cannot be
//     detected: getLogs proves INCLUSION, never completeness, and its callers must treat logs as hints;
//   * the operator's OWN TRANSACTION BACKEND (ENCLAVE_CHAIN_TX_BACKEND: the operator's own Base node on a loopback or
//     private address literal, never a name), for what no proof can answer: submission, the pending-pool nonce and fee
//     hints. It is never asked for state, and before any submission its chain is BOUND to the verifier's (same chain id,
//     the same hash at the verifier's confirmed block). A submission proves nothing: inclusion is shown only by a receipt
//     the verifier checks. Without a backend nothing can be sent (refused in words, never via any other server);
//   * anything else is REFUSED by name. There is no provider pool, no fallback, and no quorum of aliases: a consumer that
//     needs agreement treats this client as ONE authority (VERIFIER_CLIENT).
// An invalid selection yields an authority that refuses everything (refusingChainAuthority), never the provider path.
import { createPublicClient, custom, RpcRequestError } from 'viem';
import { verifierEndpoint } from './verified-chain.mjs';

export const AUTHORITY_ENV = 'ENCLAVE_CHAIN_AUTHORITY', VERIFIER_ENV = 'ENCLAVE_CHAIN_VERIFIER', TX_BACKEND_ENV = 'ENCLAVE_CHAIN_TX_BACKEND';
/** In-process mark of a client built here (a JSON value can never carry it): consumers treat it as one authority. */
export const VERIFIER_CLIENT = Symbol.for('enclave.chain-authority.local-verifier');
export const isVerifierClient = (c) => !!c && typeof c === 'object' && !!c[VERIFIER_CLIENT];

const V = 'verifier', B = 'backend';
/** method -> [where, trust]. eth_getTransactionCount routes by its block parameter (below). */
export const METHODS = Object.freeze({
  eth_chainId: [V, 'the verifier\'s configured chain'],
  eth_blockNumber: [V, 'the verifier\'s sequencer-signed unsafe head'],
  eth_getBlockByNumber: [V, 'a block of the verifier\'s signed head chain (signed head or authenticated ancestry)'],
  eth_getBlockByHash: [V, 'a block of the verifier\'s signed head chain (signed head or authenticated ancestry)'],
  eth_call: [V, 'executed locally over state proven against the block state root'],
  eth_estimateGas: [V, 'executed locally over state proven against the block state root'],
  eth_getBalance: [V, 'account proof against the block state root'],
  eth_getCode: [V, 'code proven against the account\'s code hash'],
  eth_getStorageAt: [V, 'storage proof against the block state root'],
  eth_getTransactionReceipt: [V, 'receipt checked against the receipts root of a verified block'],
  eth_getBlockReceipts: [V, 'receipts checked against the receipts root of a verified block'],
  eth_getLogs: [V, 'each log checked against its block\'s receipts: INCLUSION only, completeness not proven'],
  eth_getTransactionCount: [V, 'account proof against the block state root (pending: the own backend\'s pool hint)'],
  eth_sendRawTransaction: [B, 'submission only: inclusion is shown solely by a receipt the verifier checks'],
  eth_maxPriorityFeePerGas: [B, 'fee hint from the own backend (cost, not validity)'],
  eth_feeHistory: [B, 'fee hint from the own backend (cost, not validity)'],
  eth_gasPrice: [B, 'fee hint from the own backend (cost, not validity)'],
});
export const VERIFIED_METHODS = Object.freeze(Object.keys(METHODS).filter((m) => METHODS[m][0] === V));
export const BACKEND_METHODS = Object.freeze(Object.keys(METHODS).filter((m) => METHODS[m][0] === B));

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** The operator's own backend: http(s) at a loopback or private IPv4 literal (10/8 incl. the guest host link 10.0.2.2,
 *  172.16/12, 192.168/16, 127/8) or [::1]; no name (a name could be anyone's), no credentials, query or fragment. */
export function checkOwnBackend(raw) {
  const bad = (m) => { throw new Error(`${TX_BACKEND_ENV}: ${m}`); };
  let u; try { u = new URL(String(raw)); } catch { bad('must be a URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') bad('must be http(s)');
  if (u.username || u.password || u.search || u.hash || String(raw).includes('#') || String(raw).includes('?')) bad('no credentials, query or fragment');
  let scope = null;
  if (u.hostname === '[::1]') scope = 'loopback';
  else {
    const m = IPV4.exec(u.hostname);
    if (!m) bad('must be a loopback or private IPv4 address literal: a name or public address is not the operator\'s own backend');
    const o = m.slice(1).map(Number);
    if (o.some((x) => x > 255)) bad('malformed IPv4 address');
    if (o[0] === 127) scope = 'loopback';
    else if (o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)) scope = 'private';
    else bad('must be a loopback or private IPv4 address literal: a public address is not the operator\'s own backend');
  }
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return Object.freeze({ url: u.href, scope, label: `${u.protocol}//${u.hostname}:${port}` });
}

const MAX_RESPONSE = 32 << 20;
async function readBounded(r, max) {
  const len = Number(r.headers.get('content-length') || 0);
  if (len > max) throw new Error(`response larger than ${max} bytes`);
  const chunks = []; let n = 0;
  for await (const c of r.body) { n += c.length; if (n > max) throw new Error(`response larger than ${max} bytes`); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
/** One JSON-RPC call; a JSON-RPC error keeps its code, message and data (viem decodes reverts from them). */
function rpcCaller(url, label, timeoutMs, fetchImpl) {
  let id = 0;
  return async (method, params) => {
    const body = { jsonrpc: '2.0', id: ++id, method, params };
    let r;
    try { r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw Object.assign(new Error(`${label} unreachable: ${String(e?.message || e).slice(0, 200)}`), { authorityUnavailable: true }); }
    if (!r.ok) throw Object.assign(new Error(`${label} HTTP ${r.status}`), { authorityUnavailable: true });
    const j = JSON.parse(await readBounded(r, MAX_RESPONSE));
    if (j?.error) throw new RpcRequestError({ body, url: label, error: { code: Number(j.error.code) || -32603, message: String(j.error.message || 'error').slice(0, 2000), data: j.error.data } });
    return j?.result;
  };
}
const refused = (method, why) => new RpcRequestError({ body: { method }, url: 'chain-authority', error: { code: -32601, message: `${method} refused by the local chain authority: ${why}` } });

/**
 * -> null when the operator did not select the verifier (the legacy provider path is the caller's, unchanged), or the
 * authority. Throws on an invalid selection: callers then use refusingChainAuthority(why), never the provider path.
 */
export function chainAuthorityFromEnv(env = process.env, opts = {}) {
  const a = String(env[AUTHORITY_ENV] || '').trim(), v = String(env[VERIFIER_ENV] || '').trim(), b = String(env[TX_BACKEND_ENV] || '').trim();
  if (!a || a === 'quorum') {
    if (v || b) throw new Error(`${v ? VERIFIER_ENV : TX_BACKEND_ENV} is set but ${AUTHORITY_ENV} is not verifier`);
    return null;
  }
  if (a !== 'verifier') throw new Error(`${AUTHORITY_ENV} must be quorum or verifier`);
  if (!v) throw new Error(`${AUTHORITY_ENV}=verifier needs ${VERIFIER_ENV} (the local verifier URL)`);
  return createChainAuthority({ verifier: v, backend: b || null, ...opts });
}

/**
 * createChainAuthority({verifier, backend?, chain, maxHeadAgeMs, futureSkewMs, confirmations, bindTtlMs, timeoutMs, fetch, now})
 *   .client         a viem public client (marked VERIFIER_CLIENT) over the routed transport
 *   .transport      the same transport, for a wallet client (writeContract prepares through it, sends to the backend)
 *   .describe()     what is used, with the trust labels (logs and status)
 *   .actionGate(w)  before any action that writes or signs: the verifier's head is fresh, and (when `w.submit`) the
 *                   backend is configured and bound to the verifier's chain. Throws {code, status 503} otherwise.
 *   .status()       the last gate result (for /health and logs; never evidence)
 */
export function createChainAuthority({ verifier, backend = null, chain, maxHeadAgeMs = 60_000, futureSkewMs = 5_000, confirmations = 2,
  bindTtlMs = 15_000, timeoutMs = 20_000, fetch: fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!chain || !Number.isSafeInteger(chain.id)) throw new Error('chain authority needs the chain (viem chain object)');
  const vEnd = verifierEndpoint(verifier);                 // loopback only; a remote "verifier" is refused here
  const own = backend ? checkOwnBackend(backend) : null;
  const callV = rpcCaller(typeof verifier === 'string' ? verifier : verifier.url, vEnd.label, timeoutMs, fetchImpl);
  const callB = own ? rpcCaller(own.url, `own backend ${own.label}`, timeoutMs, fetchImpl) : null;
  let bound = null;                                        // {at, number, hash} of the last successful binding
  let last = { at: 0, ok: false, why: 'not checked yet' };
  const fail = (code, message) => Object.assign(new Error(message), { code, status: 503 });

  async function bindBackend() {
    if (!callB) throw fail('chain_no_backend', `no own transaction backend is configured (${TX_BACKEND_ENV}): nothing is submitted through any other server`);
    if (bound && now() - bound.at < bindTtlMs) return bound;
    const want = BigInt(chain.id);
    if (BigInt(await callB('eth_chainId', [])) !== want) throw fail('chain_backend_wrong_chain', `the own backend ${own.label} follows another chain`);
    const head = BigInt(await callV('eth_blockNumber', []));
    const n = head - BigInt(confirmations);
    if (n < 0n) throw fail('chain_unconfirmed', 'the verifier has no confirmed block yet');
    const tag = '0x' + n.toString(16);
    const [vb, bb] = await Promise.all([callV('eth_getBlockByNumber', [tag, false]), callB('eth_getBlockByNumber', [tag, false])]);
    if (!vb?.hash) throw fail('chain_unconfirmed', `the verifier has no block ${n}`);
    if (!bb?.hash) throw fail('chain_backend_behind', `the own backend ${own.label} has no block ${n} (behind the verifier)`);
    if (String(bb.hash).toLowerCase() !== String(vb.hash).toLowerCase())
      throw fail('chain_backend_unbound', `the own backend ${own.label} has another block ${n} than the verifier's signed head chain: not submitting through it`);
    bound = { at: now(), number: n, hash: String(vb.hash).toLowerCase() };
    return bound;
  }
  async function actionGate({ what = 'action', submit = false } = {}) {
    try {
      const blk = await callV('eth_getBlockByNumber', ['latest', false]);
      let ts; try { ts = Number(BigInt(blk.timestamp)) * 1000; } catch { throw fail('chain_unconfirmed', 'the verifier has no head block'); }
      if (ts > now() + futureSkewMs) throw fail('chain_future', 'the verifier\'s head is ahead of this host\'s clock');
      if (now() - ts > maxHeadAgeMs) throw fail('chain_stale', `the verifier's head is ${Math.round((now() - ts) / 1000)} s old (more than ${Math.round(maxHeadAgeMs / 1000)} s)`);
      if (submit) await bindBackend();
      last = { at: now(), ok: true, why: null, head: String(BigInt(blk.number)) };
    } catch (e) {
      const err = e?.code && e.status ? e : fail('chain_unavailable', `the local verifier cannot answer (${String(e?.message || e).slice(0, 200)})`);
      last = { at: now(), ok: false, why: err.message, code: err.code };
      throw Object.assign(err, { message: `${what} not done: ${err.message}` });
    }
  }

  async function request({ method, params = [] }) {
    const route = METHODS[method];
    if (!route) throw refused(method, `not a proof-backed or own-backend method (verified: ${VERIFIED_METHODS.join(', ')}; own backend: ${BACKEND_METHODS.join(', ')})`);
    if (method === 'eth_getTransactionCount' && (params[1] === 'pending')) {
      if (!callB) throw refused(method, `the pending pool is only known to an own transaction backend (${TX_BACKEND_ENV} unset)`);
      return callB(method, params);
    }
    if (route[0] === B) {
      if (!callB) throw refused(method, `no own transaction backend is configured (${TX_BACKEND_ENV}): nothing is sent or asked elsewhere`);
      if (method === 'eth_sendRawTransaction') {
        try { await actionGate({ what: 'submission', submit: true }); }
        catch (e) { throw refused(method, e.message); }
      }
      return callB(method, params);
    }
    try { return await callV(method, params); }
    catch (e) {
      // Helios answers an unknown receipt with an error; a provider answers null. Both mean only "no receipt evidence"
      // (absence is never proven): callers resolve such a transaction by its proven account nonce instead.
      if (method === 'eth_getTransactionReceipt' && e instanceof RpcRequestError && /receipt not found/i.test(String(e.details || e.message))) return null;
      throw e;
    }
  }
  const transport = custom({ request }, { key: 'local-verifier', name: 'Local verifier', retryCount: 0 });
  const client = createPublicClient({ chain, transport });
  const describe = () => ({ authority: 'local-verifier', tier: 'unsafe', finality: 'none', verifier: vEnd.label,
    backend: own ? { label: own.label, scope: own.scope, use: BACKEND_METHODS.concat('eth_getTransactionCount(pending)') } : null,
    logs: 'inclusion only (completeness not proven)' });
  Object.defineProperty(client, VERIFIER_CLIENT, { value: Object.freeze({ describe }), enumerable: false });
  return Object.freeze({ mode: 'verifier', client, transport, describe, actionGate, bindBackend, status: () => ({ ...last }) });
}

/** The authority a host gets when its selection is invalid: every method refuses with the reason; nothing falls back. */
export function refusingChainAuthority(why, { chain } = {}) {
  const request = async ({ method }) => { throw refused(method, `the chain authority selection is invalid (${why})`); };
  const transport = custom({ request }, { key: 'refusing', name: 'Refusing chain authority', retryCount: 0 });
  const client = createPublicClient({ chain, transport });
  const describe = () => ({ authority: 'refusing', why });
  Object.defineProperty(client, VERIFIER_CLIENT, { value: Object.freeze({ describe }), enumerable: false });
  const gate = async ({ what = 'action' } = {}) => { throw Object.assign(new Error(`${what} not done: the chain authority selection is invalid (${why})`), { code: 'chain_misconfigured', status: 503 }); };
  return Object.freeze({ mode: 'refusing', client, transport, describe, actionGate: gate, bindBackend: gate, status: () => ({ ok: false, why }) });
}
