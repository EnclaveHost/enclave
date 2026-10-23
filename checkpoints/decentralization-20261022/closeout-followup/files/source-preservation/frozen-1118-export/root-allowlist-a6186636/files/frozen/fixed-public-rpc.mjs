// A host's PUBLIC Base JSON-RPC endpoint for browser dashboards (host-service role 'public-rpc'; network/host-services/
// roles.mjs; reached as rpc-<base32(registry id)>.<zone> through the host-service ingress, host-service-names.mjs). It
// answers the read and estimate methods the dashboard's network profile sends (work/browser-rpc-closure
// NOTE-BROWSER-RPC-ENDPOINT-REQUIREMENTS.md) from the OPERATOR'S OWN Base node on this machine, and nothing else:
//   - the node is a loopback URL (the operator's local client or holder); a remote "node" is refused at configuration, so
//     this is never a proxy to a third-party provider, and nobody can name another upstream in a request;
//   - methods: an exact allowlist with strictly checked parameters (EIP-1898 block objects included). Admin, debug,
//     personal, txpool, signing, account and filter methods are refused by name, never forwarded; batches are refused;
//   - an optional proof-backed LOCAL verifier (chainVerifier, loopback) answers ONLY the methods it supports
//     (verifiedMethods); those never fall back to the node, and the node's methods are never labelled verified. Every
//     answer says which one answered (X-Enclave-Rpc-Source: node | verifier). Neither is a cryptographic proof to the
//     browser: the browser trusts this endpoint, as it trusts any RPC origin in its profile;
//   - honesty: a node that is syncing or whose head is older than maxHeadAgeSec refuses (503) instead of answering stale
//     state; eth_sendRawTransaction is refused unless the operator states how its node propagates transactions
//     (rawTransactions.propagation), and then the node's own answer is returned unchanged (never a fabricated hash);
//   - bounds: request body, response size, one backend deadline, in-flight requests and an aggregate token bucket (the
//     ingress hands every connection over loopback, so per-client limits are the exits' and the ingress's);
//   - CORS: only the configured dashboard origins (or "*" written explicitly), POST with content-type only, never
//     credentials; no redirect is followed or sent.
// The role holds no key, no secret and no wallet. It is not indexed: no EnclaveServiceIndex kind names an RPC endpoint, so
// browsers reach it only through a profile that lists its URL.
//   node network/public-rpc.mjs <config.json>     prints {"type":"ready","port":N}
import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { rpcEndpoint } from './rpc-identity.mjs';

export const ROLE = 'public-rpc';
const ADDR = /^0x[0-9a-fA-F]{40}$/, HASH = /^0x[0-9a-fA-F]{64}$/, QTY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/, HEX = /^0x([0-9a-fA-F]{2})*$/;
const TAGS = new Set(['latest', 'earliest', 'safe', 'finalized']);
// what the local verifier can answer from proofs at a pinned block (network/verified-chain.mjs pinnedClient)
export const VERIFIABLE_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_call', 'eth_getCode', 'eth_getStorageAt', 'eth_getBalance']);
// refused by NAME (never forwarded): node administration, debugging, wallets, signing, mempool and server-side filters
const FORBIDDEN = /^(admin|debug|personal|miner|txpool|clique|engine|parity|trace|ots|anvil|hardhat|evm|wallet|rpc)_|^eth_(sign|signTransaction|signTypedData.*|sendTransaction|accounts|coinbase|mining|hashrate|submitWork|submitHashrate|getWork|newFilter|newBlockFilter|newPendingTransactionFilter|getFilterChanges|getFilterLogs|uninstallFilter|subscribe|unsubscribe|getProof|createAccessList|simulateV1|callMany)$/;
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const fail = (m) => { throw new Error(`public-rpc: ${m}`); };
const SECRETISH = /(secret|token|password|passwd|private|mnemonic|seed|apikey|api_key|auth|hmac|credential|key$|keyfile)/i;
const FIELDS = ['port', 'bind', 'hostId', 'chainId', 'node', 'chainVerifier', 'verifiedMethods', 'allowedOrigins', 'maxHeadAgeSec', 'rawTransactions', 'limits'];
const LIMITS = Object.freeze({ maxBodyBytes: [1024, 1 << 20, 128 << 10], maxResponseBytes: [64 << 10, 16 << 20, 4 << 20], backendTimeoutMs: [500, 30000, 6000],
  maxInFlight: [1, 256, 16], perSecond: [1, 10000, 50], burst: [1, 20000, 100], maxLogRange: [1, 10000, 2000] });

function loopbackUrl(v, what) {
  let e; try { e = rpcEndpoint(v); } catch (x) { fail(`${what}: ${x.message}`); }
  if (!e.loopback) fail(`${what} must be this machine's own endpoint (loopback): a remote server would make this role a proxy`);
  return String(v);
}

/** -> the normalized configuration; throws on anything else. No field may hold a secret. */
export function validatePublicRpcConfig(c) {
  if (!plain(c)) fail('config must be an object');
  for (const k of Object.keys(c)) if (!FIELDS.includes(k)) fail(`unknown config field ${JSON.stringify(k)}${SECRETISH.test(k) ? ' (the role holds no secret)' : ''}`);
  for (const k of ['port', 'bind', 'hostId', 'chainId', 'node', 'allowedOrigins']) if (c[k] === undefined || c[k] === null || c[k] === '') fail(`${k} is required`);
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) fail('port must be a port');
  // the ingress reaches roles on loopback only (host-service-ingress.mjs serviceTable)
  if (!['127.0.0.1', '::1'].includes(c.bind)) fail('bind must be loopback (127.0.0.1 or ::1): the public reaches it only through the host-service ingress');
  if (!HASH.test(String(c.hostId)) || /^0x0{64}$/.test(c.hostId)) fail('hostId must be this host\'s registry id');
  if (!Number.isSafeInteger(c.chainId) || c.chainId <= 0) fail('chainId is required');
  const node = loopbackUrl(c.node, 'node');
  let verifier = null, verifiedMethods = [];
  if (c.chainVerifier !== undefined || c.verifiedMethods !== undefined) {
    verifier = loopbackUrl(c.chainVerifier, 'chainVerifier');
    if (rpcEndpoint(verifier).url.href === rpcEndpoint(node).url.href) fail('chainVerifier is the node itself: an unverified node is not a verifier');
    if (!Array.isArray(c.verifiedMethods) || !c.verifiedMethods.length || c.verifiedMethods.some((m) => !VERIFIABLE_METHODS.includes(m)) || new Set(c.verifiedMethods).size !== c.verifiedMethods.length)
      fail(`verifiedMethods: the methods the verifier answers from proofs, a subset of ${VERIFIABLE_METHODS.join(', ')}`);
    verifiedMethods = [...c.verifiedMethods];
  }
  const origins = c.allowedOrigins;
  if (!Array.isArray(origins) || !origins.length || origins.length > 16) fail('allowedOrigins: 1 to 16 dashboard origins, or ["*"]');
  const allowed = origins[0] === '*' && origins.length === 1 ? '*' : origins.map((o, i) => {
    let u; try { u = new URL(o); } catch { fail(`allowedOrigins[${i}] is not a URL`); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local)) || u.username || u.password || u.search || u.hash || u.pathname !== '/')
      fail(`allowedOrigins[${i}] must be a bare https origin (http only on localhost)`);
    return u.origin;
  });
  const maxHeadAgeSec = c.maxHeadAgeSec ?? 120;
  if (!Number.isInteger(maxHeadAgeSec) || maxHeadAgeSec < 10 || maxHeadAgeSec > 3600) fail('maxHeadAgeSec: 10 to 3600');
  let rawTransactions = null;
  if (c.rawTransactions !== undefined) {
    if (!plain(c.rawTransactions) || Object.keys(c.rawTransactions).some((k) => k !== 'propagation') || typeof c.rawTransactions.propagation !== 'string'
      || c.rawTransactions.propagation.length < 8 || c.rawTransactions.propagation.length > 200 || /[\u0000-\u001f]/.test(c.rawTransactions.propagation))
      fail('rawTransactions: { propagation: "<how the operator\'s node propagates a raw transaction (8-200 characters)>" } - omit it to refuse submissions');
    rawTransactions = { propagation: c.rawTransactions.propagation };
  }
  const limits = {};
  if (c.limits !== undefined && !plain(c.limits)) fail('limits must be an object');
  for (const k of Object.keys(c.limits || {})) if (!Object.hasOwn(LIMITS, k)) fail(`limits: unknown field ${JSON.stringify(k)}`);
  for (const [k, [lo, hi, def]] of Object.entries(LIMITS)) {
    const v = (c.limits || {})[k] ?? def;
    if (!Number.isInteger(v) || v < lo || v > hi) fail(`limits.${k}: ${lo} to ${hi}`);
    limits[k] = v;
  }
  if (limits.burst < limits.perSecond) fail('limits.burst must be at least limits.perSecond');
  return { port: c.port, bind: c.bind, hostId: c.hostId.toLowerCase(), chainId: c.chainId, node, ...(verifier ? { chainVerifier: verifier, verifiedMethods } : {}),
    allowedOrigins: allowed === '*' ? ['*'] : allowed, maxHeadAgeSec, ...(rawTransactions ? { rawTransactions } : {}), limits };
}

/* ---- parameters: exact shapes only ---- */
class ParamError extends Error {}
const bad = (m) => { throw new ParamError(m); };
const block = (v, { tagsOnly = false } = {}) => {
  if (typeof v === 'string') { if (TAGS.has(v) || QTY.test(v)) return; bad('block must be a hex number, latest, earliest, safe or finalized (pending is not served)'); }
  if (!tagsOnly && plain(v)) {                                   // EIP-1898
    const keys = Object.keys(v);
    if (keys.includes('blockHash')) { if (!HASH.test(String(v.blockHash)) || keys.some((k) => !['blockHash', 'requireCanonical'].includes(k)) || (v.requireCanonical !== undefined && typeof v.requireCanonical !== 'boolean')) bad('{blockHash, requireCanonical?}'); return; }
    if (keys.length === 1 && keys[0] === 'blockNumber' && QTY.test(String(v.blockNumber))) return;
  }
  bad('invalid block parameter');
};
const addr = (v, what = 'address') => { if (typeof v !== 'string' || !ADDR.test(v)) bad(`${what} must be an address`); };
const hash = (v) => { if (typeof v !== 'string' || !HASH.test(v)) bad('a 32-byte hash is required'); };
const TX_KEYS = { from: addr, to: addr, gas: 'qty', gasPrice: 'qty', maxFeePerGas: 'qty', maxPriorityFeePerGas: 'qty', value: 'qty', nonce: 'qty', data: 'hex', input: 'hex' };
function tx(v) {
  if (!plain(v)) bad('the call must be a transaction object');
  for (const [k, x] of Object.entries(v)) {
    const t = Object.hasOwn(TX_KEYS, k) ? TX_KEYS[k] : null;
    if (!t) bad(`unsupported call field ${JSON.stringify(k).slice(0, 40)}`);
    if (t === 'qty' ? !(typeof x === 'string' && QTY.test(x)) : t === 'hex' ? !(typeof x === 'string' && HEX.test(x)) : (t(x, k), false)) bad(`invalid ${k}`);
  }
}
const arity = (p, lo, hi) => { if (!Array.isArray(p) || p.length < lo || p.length > hi) bad(`expects ${lo === hi ? lo : `${lo} to ${hi}`} parameters`); };
function logFilter(f, limits, head) {
  if (!plain(f)) bad('the filter must be an object');
  for (const k of Object.keys(f)) if (!['address', 'topics', 'fromBlock', 'toBlock', 'blockHash'].includes(k)) bad(`unsupported filter field ${JSON.stringify(k).slice(0, 40)}`);
  addr(f.address, 'filter.address (exactly one contract)');
  if (f.topics !== undefined) {
    if (!Array.isArray(f.topics) || f.topics.length > 4) bad('topics: at most 4 positions');
    for (const t of f.topics) if (!(t === null || (typeof t === 'string' && HASH.test(t)) || (Array.isArray(t) && t.length >= 1 && t.length <= 4 && t.every((x) => typeof x === 'string' && HASH.test(x))))) bad('topics: null, a hash or 1-4 hashes per position');
  }
  if (f.blockHash !== undefined) { hash(f.blockHash); if (f.fromBlock !== undefined || f.toBlock !== undefined) bad('blockHash excludes fromBlock/toBlock'); return; }
  const num = (v, what) => { if (v === 'latest') return head; if (typeof v === 'string' && QTY.test(v)) return BigInt(v); return bad(`${what}: a hex block number or latest`); };
  const from = num(f.fromBlock, 'fromBlock'), to = num(f.toBlock ?? 'latest', 'toBlock');
  if (from === null || to === null) bad('the node head is unknown');
  if (to < from) bad('toBlock is before fromBlock');
  if (to - from + 1n > BigInt(limits.maxLogRange)) bad(`log ranges are at most ${limits.maxLogRange} blocks`);
}
/** method -> check(params, ctx) */
const METHODS = {
  eth_chainId: (p) => arity(p, 0, 0),
  eth_blockNumber: (p) => arity(p, 0, 0),
  eth_getBlockByNumber: (p) => { arity(p, 2, 2); block(p[0], { tagsOnly: true }); if (p[1] !== false) bad('full transaction objects are not served (pass false)'); },
  eth_call: (p) => { arity(p, 2, 2); tx(p[0]); block(p[1]); },
  eth_estimateGas: (p) => { arity(p, 1, 2); tx(p[0]); if (p.length === 2) block(p[1]); },
  eth_getCode: (p) => { arity(p, 2, 2); addr(p[0]); block(p[1]); },
  eth_getBalance: (p) => { arity(p, 2, 2); addr(p[0]); block(p[1]); },
  eth_getTransactionCount: (p) => { arity(p, 2, 2); addr(p[0]); block(p[1]); },
  eth_getStorageAt: (p) => { arity(p, 3, 3); addr(p[0]); if (typeof p[1] !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(p[1])) bad('slot must be a hex word'); block(p[2]); },
  eth_getLogs: (p, ctx) => { arity(p, 1, 1); logFilter(p[0], ctx.limits, ctx.head); },
  eth_getTransactionReceipt: (p) => { arity(p, 1, 1); hash(p[0]); },
  eth_getTransactionByHash: (p) => { arity(p, 1, 1); hash(p[0]); },
  eth_sendRawTransaction: (p) => { arity(p, 1, 1); if (typeof p[0] !== 'string' || !HEX.test(p[0]) || p[0].length < 4) bad('a signed raw transaction (hex)'); },
};
export const SERVED_METHODS = Object.freeze(Object.keys(METHODS));

/**
 * createPublicRpc(config, { fetch, now, log }) -> { port, close(), status() }. fetch: the backend transport (tests count
 * it); it is called ONLY with the configured node or verifier URL.
 */
export async function createPublicRpc(rawConfig, { fetch: backendFetch = globalThis.fetch, now = Date.now, log = () => {} } = {}) {
  const cfg = validatePublicRpcConfig(rawConfig), L = cfg.limits;
  const verified = new Set(cfg.verifiedMethods || []);
  let tokens = L.burst, refill = now(), inFlight = 0, id = 0, health = null, healthAt = 0, healthPending = null;

  // one JSON-RPC call to the node or the verifier, bounded in time and size; -> {result} | {error} | throws (unreachable)
  async function backend(url, method, params) {
    const r = await backendFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(L.backendTimeoutMs) });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { unreachable: true });
    const reader = r.body?.getReader?.(); let size = 0; const parts = [];
    if (reader) for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > L.maxResponseBytes) { await reader.cancel().catch(() => {}); throw Object.assign(new Error(`the answer is larger than ${L.maxResponseBytes} bytes`), { tooLarge: true }); }
      parts.push(value);
    }
    const j = JSON.parse(reader ? Buffer.concat(parts).toString('utf8') : await r.text());
    if (j && j.error) return { error: { code: Number.isInteger(j.error.code) ? j.error.code : -32000, message: String(j.error.message || 'error').slice(0, 500),
      ...(j.error.data !== undefined ? { data: typeof j.error.data === 'string' ? j.error.data.slice(0, 65536) : j.error.data } : {}) } };
    return { result: j ? j.result : null };
  }
  // the node's sync state, at most once per 2 s: syncing, or a head older than maxHeadAgeSec, refuses node methods
  async function nodeHealth() {
    if (health && now() - healthAt < 2000) return health;
    return (healthPending ||= (async () => {
      try {
        const [chain, syncing, head] = await Promise.all([backend(cfg.node, 'eth_chainId', []), backend(cfg.node, 'eth_syncing', []), backend(cfg.node, 'eth_getBlockByNumber', ['latest', false])]);
        const b = head.result, age = b && QTY.test(String(b.timestamp)) ? Math.floor(now() / 1000) - Number(BigInt(b.timestamp)) : null;
        if (chain.error || Number(BigInt(chain.result || '0x0')) !== cfg.chainId) health = { ok: false, reason: `the node does not serve chain ${cfg.chainId}` };
        else if (syncing.error || (syncing.result !== false)) health = { ok: false, reason: 'the operator\'s node is syncing (answers would be stale)' };
        else if (!b || age === null) health = { ok: false, reason: 'the operator\'s node reports no head' };
        else if (age > cfg.maxHeadAgeSec) health = { ok: false, reason: `the operator's node head is ${age} s old (limit ${cfg.maxHeadAgeSec} s)` };
        else health = { ok: true, head: BigInt(b.number), headAgeSec: age };
      } catch (e) { health = { ok: false, reason: 'the operator\'s node is unreachable' + (e.name === 'TimeoutError' ? ' (timed out)' : '') }; }
      healthAt = now(); healthPending = null; return health;
    })());
  }
  const corsOrigin = (origin) => cfg.allowedOrigins[0] === '*' ? '*' : (origin && cfg.allowedOrigins.includes(origin) ? origin : null);
  const send = (res, status, body, { origin = null, source = null, extra = {} } = {}) => {
    const h = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-enclave-rpc-host': cfg.hostId, ...extra };
    if (source) h['x-enclave-rpc-source'] = source;
    if (origin) Object.assign(h, { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-expose-headers': 'x-enclave-rpc-source, x-enclave-rpc-host' });
    res.writeHead(status, h); res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const rpcError = (reqId, code, message, data) => ({ jsonrpc: '2.0', id: reqId ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  const take = () => {
    const t = now(); tokens = Math.min(L.burst, tokens + ((t - refill) / 1000) * L.perSecond); refill = t;
    if (tokens < 1) return false; tokens -= 1; return true;
  };

  async function handle(req, res) {
    const origin = req.headers.origin;
    const allowed = origin === undefined ? null : corsOrigin(origin);
    const url = req.url || '/';
    if (origin !== undefined && !allowed) return send(res, 403, rpcError(null, -32003, 'this origin is not allowed to use this endpoint'));
    if (req.method === 'OPTIONS') {
      const m = req.headers['access-control-request-method'], hdrs = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
      if (url !== '/' || m !== 'POST' || hdrs.some((x) => x !== 'content-type')) { res.writeHead(403, { 'content-length': '0' }); return res.end(); }
      res.writeHead(204, { ...(allowed ? { 'access-control-allow-origin': allowed, vary: 'Origin' } : {}), 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600', 'content-length': '0' });
      return res.end();
    }
    if (req.method === 'GET' && url === '/health') {
      const h = await nodeHealth();
      return send(res, h.ok ? 200 : 503, { role: ROLE, hostId: cfg.hostId, chainId: cfg.chainId,
        node: h.ok ? { synced: true, head: String(h.head), headAgeSec: h.headAgeSec } : { synced: false, reason: h.reason },
        verifiedMethods: [...verified], rawTransactions: cfg.rawTransactions ? { offered: true, propagation: cfg.rawTransactions.propagation, checkedByThisRole: false } : { offered: false },
        methods: SERVED_METHODS.filter((m) => m !== 'eth_sendRawTransaction' || cfg.rawTransactions), limits: L }, { origin: allowed });
    }
    if (url !== '/') return send(res, 404, rpcError(null, -32004, 'not found'), { origin: allowed });
    if (req.method !== 'POST') return send(res, 405, rpcError(null, -32004, 'POST JSON-RPC to /'), { origin: allowed, extra: { allow: 'POST, OPTIONS' } });
    if (!/^application\/json(\s*;.*)?$/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, rpcError(null, -32700, 'content-type must be application/json'), { origin: allowed });
    if (!take()) return send(res, 429, rpcError(null, -32005, 'rate limited: retry shortly'), { origin: allowed, extra: { 'retry-after': '1' } });
    if (inFlight >= L.maxInFlight) return send(res, 503, rpcError(null, -32005, 'busy: too many requests in flight'), { origin: allowed, extra: { 'retry-after': '1' } });
    inFlight++;
    try {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > L.maxBodyBytes) return send(res, 413, rpcError(null, -32600, `the request is larger than ${L.maxBodyBytes} bytes`), { origin: allowed });
      let size = 0; const parts = [];
      for await (const chunk of req) { size += chunk.length; if (size > L.maxBodyBytes) return send(res, 413, rpcError(null, -32600, `the request is larger than ${L.maxBodyBytes} bytes`), { origin: allowed }); parts.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return send(res, 200, rpcError(null, -32700, 'parse error'), { origin: allowed }); }
      if (Array.isArray(body)) return send(res, 200, rpcError(null, -32600, 'batch requests are not served: send one call per request'), { origin: allowed });
      const reqId = body?.id;
      if (!plain(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || !(reqId === undefined || reqId === null || (typeof reqId === 'number' && Number.isSafeInteger(reqId)) || (typeof reqId === 'string' && reqId.length <= 64)))
        return send(res, 200, rpcError(null, -32600, 'invalid JSON-RPC 2.0 request'), { origin: allowed });
      const method = body.method, params = body.params === undefined ? [] : body.params;
      if (FORBIDDEN.test(method)) return send(res, 200, rpcError(reqId, -32601, `${method.slice(0, 64)} is not offered by a public endpoint (no administration, debugging, signing, accounts, mempool or filters)`), { origin: allowed });
      const check = Object.hasOwn(METHODS, method) ? METHODS[method] : null;
      if (!check) return send(res, 200, rpcError(reqId, -32601, `${method.slice(0, 64)} is not offered by this endpoint`), { origin: allowed });
      if (method === 'eth_sendRawTransaction' && !cfg.rawTransactions)
        return send(res, 200, rpcError(reqId, -32601, 'eth_sendRawTransaction is not offered: this operator has not stated a transaction propagation route for its node (nothing was submitted)'), { origin: allowed });
      const viaVerifier = verified.has(method);
      let head = null;
      if (!viaVerifier) {
        const h = await nodeHealth();
        if (!h.ok) return send(res, 503, rpcError(reqId, -32002, h.reason + '; nothing was answered from it'), { origin: allowed, source: 'node', extra: { 'retry-after': '5' } });
        head = h.head;
      }
      try { check(params, { limits: L, head }); } catch (e) { if (e instanceof ParamError) return send(res, 200, rpcError(reqId, -32602, `invalid params: ${e.message}`), { origin: allowed }); throw e; }
      let out;
      try { out = await backend(viaVerifier ? cfg.chainVerifier : cfg.node, method, params); }
      catch (e) {
        const what = viaVerifier ? 'the operator\'s local verifier' : 'the operator\'s node';
        if (viaVerifier) log(`[public-rpc] ${method}: verifier unavailable (${e.message}); no node fallback`);
        return send(res, e.tooLarge ? 502 : e.name === 'TimeoutError' ? 504 : 503, rpcError(reqId, -32002, `${what} ${e.tooLarge ? 'answered more than this endpoint returns' : e.name === 'TimeoutError' ? `did not answer within ${L.backendTimeoutMs} ms` : 'is unavailable'}; nothing was answered${viaVerifier ? ' (verified methods never fall back to the node)' : ''}`),
          { origin: allowed, source: viaVerifier ? 'verifier' : 'node' });
      }
      const extra = method === 'eth_sendRawTransaction' ? { 'x-enclave-rpc-propagation': 'operator-stated' } : {};
      return send(res, 200, out.error ? { jsonrpc: '2.0', id: reqId ?? null, error: out.error } : { jsonrpc: '2.0', id: reqId ?? null, result: out.result },
        { origin: allowed, source: viaVerifier ? 'verifier' : 'node', extra });
    } finally { inFlight--; }
  }

  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { log(`[public-rpc] ${e.message}`); if (!res.headersSent) send(res, 500, rpcError(null, -32603, 'internal error')); else res.destroy(); }); });
  // bounded connections: a slow client cannot hold a request open past these
  server.headersTimeout = 10_000; server.requestTimeout = L.backendTimeoutMs + 5_000; server.keepAliveTimeout = 5_000; server.maxHeadersCount = 64;
  await new Promise((ok, no) => { server.once('error', no); server.listen(cfg.port, cfg.bind, ok); });
  log(`[public-rpc] serving ${SERVED_METHODS.length - (cfg.rawTransactions ? 0 : 1)} methods on ${cfg.bind}:${server.address().port} from the operator's node${verified.size ? `; verified by the local verifier: ${[...verified].join(', ')}` : ''}; raw transactions ${cfg.rawTransactions ? 'forwarded (operator-stated propagation)' : 'refused'}`);
  return { port: server.address().port, config: cfg, close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }), nodeHealth };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const running = await createPublicRpc(config, { log: (m) => console.log(m) });
  console.log(JSON.stringify({ type: 'ready', port: running.port }));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { running.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
}
