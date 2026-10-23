// The loopback execution endpoint a Helios verifier reads state WITNESSES from (helios --execution-rpc). Helios takes
// ONE execution URL and verifies everything it gets from it against its signed head (account/storage proofs against the
// block's state root, code against the proven code hash, receipts against the receipts root), so the sources behind
// this gateway are untrusted: any one honest, available source is enough, and none of them is a vote.
//
//   * Witnesses pinned BY BLOCK HASH (eth_getProof, eth_getCode) are VERIFIED HERE before they are served or cached,
//     with Helios's own proof code (network/witness-verify.mjs -> the witness-check helper) against the state root of a
//     signed sequencer head for that block (the root store; never a root from a witness source). A malformed or invalid
//     answer costs its source the try: the next source is asked. One lying source therefore cannot deny a witness
//     another source can prove, and nothing unverified is ever returned. Without an authenticated root for the block
//     (or with the verifier unavailable) the request is REFUSED; it is never passed through unchecked.
//   * A block whose signed head the root store never saw (a poll gap, a cold start, an older confirmed block) is
//     recovered by AUTHENTICATED ANCESTRY: untrusted headers from the same upstreams (eth_getBlockByHash), each bound by
//     its recomputed hash to the parent hash of an already bound child, walking down from the nearest signed head
//     (network/witness-verify.mjs createRootStore). A forged or tampered header costs its source the try. Missing or
//     too-deep history is refused, and a recovered root is history for that block, never freshness.
//   * The witness cache is content-addressed and create-only: each verified answer is one immutable entry named by
//     the sha256 of its content, so a bad entry (an older unverified write, or a tampered or shared store such as a
//     Sia bucket) can never shadow a good one. Every cache read is re-verified before use, a failing entry is
//     quarantined (skipped, never deleted or overwritten), and verified entries are served before any upstream is
//     asked. A cache hit is availability for THAT block only, never freshness: the verifier still needs a fresh signed
//     head, and Helios rejects a witness that does not match it.
//   * eth_getBlockByHash (Helios's historical path asks for a full block by hash) is verified too: the header must hash
//     to the requested hash, and a full-transaction body must pass Helios's OpStack::validate_block; a bad answer costs
//     its source the try. A hash-only answer is HEADER-verified only. Blocks are never cached or used as roots.
//   * Other methods (blocks by number, receipts, logs, fee data) keep ordered first-answer failover: Helios verifies
//     those against its signed head itself. A method allowlist keeps the gateway from being a general RPC proxy
//     (a16z/helios 2af9b418 core/src/execution/providers/rpc.rs, opstack evm, plus broadcast).
//   * eth_sendRawTransaction goes to every upstream. A broadcast proves nothing about inclusion (a receipt in a verified
//     block does), and with every upstream down nothing can be sent: the gateway says so.
//   * Bounds: request body, upstream response bytes (enforced while reading), per-try timeout, one total deadline per
//     request, batch size and upstream requests in flight.
// No P2P witness transport exists for Base today (rpc-peer-audit RESULT §2: snap/2 off by default, no flag; GetNodeData
// empty), so none is offered; a future transport is one more entry in `upstreams` behind the same interface. Failover
// between sources is NOT independence from them: with every fresh witness source down, only cached history remains.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { rpcEndpoint, rpcLabel } from './rpc-identity.mjs';
import { readBounded } from './witness-verify.mjs';

export const WITNESS_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getProof', 'eth_getCode',
  'eth_createAccessList', 'eth_getBlockReceipts', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_sendRawTransaction']);
/** Methods whose answers this gateway verifies (and may cache): they need `proofs`. */
export const VERIFIED_METHODS = Object.freeze(['eth_getProof', 'eth_getCode']);
const PINNED = new Set(VERIFIED_METHODS);
const MAX_BODY = 1 << 20, HASH = /^0x[0-9a-fA-F]{64}$/, ENTRY = /^[0-9a-f]{64}\.json$/;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The cache key of a block-hash-pinned witness request, or null when the request is not immutable. */
export function witnessKey(method, params) {
  if (!PINNED.has(method) || !Array.isArray(params) || !params.length) return null;
  const at = params[params.length - 1];
  // EIP-1898 {blockHash[, requireCanonical]}, or the bare 32-byte hash alloy sends when requireCanonical is unset
  // (alloy-eips BlockId::serialize). A 64-hex-digit value is never a block number.
  const hash = typeof at === 'string' ? (HASH.test(at) ? at : null)
    : at && typeof at === 'object' && !Array.isArray(at) && HASH.test(at.blockHash || '') && Object.keys(at).every((k) => k === 'blockHash' || k === 'requireCanonical') ? at.blockHash : null;
  if (!hash) return null;
  const norm = JSON.stringify([method, JSON.parse(JSON.stringify(params).toLowerCase())]);
  return { key: sha256(norm), blockHash: hash.toLowerCase(), norm };
}

/**
 * Directory witness cache: <dir>/<blockHash>/<sha256(request)>/<sha256(result JSON)>.json, create-only (atomic link,
 * never overwritten). `candidates(w)` returns every stored answer for the request (bounded), including a legacy
 * single-slot <dir>/<blockHash>/<sha256(request)>.json entry. Entries are UNTRUSTED: the gateway verifies each one.
 */
export function dirWitnessCache(dir, { maxCandidates = 32, maxEntryBytes = 16 << 20 } = {}) {
  const folder = (w) => path.join(dir, w.blockHash, w.key);
  async function read(file, w) {
    try {
      if ((await fs.promises.stat(file)).size > maxEntryBytes) return undefined;
      const e = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      return e?.format === 'enclave-witness-rpc/v1' && e.request === w.norm ? e.result : undefined;
    } catch { return undefined; }
  }
  async function candidates(w) {
    const out = [];
    let names = [];
    try { names = (await fs.promises.readdir(folder(w))).filter((n) => ENTRY.test(n)).sort().slice(0, maxCandidates); } catch {}
    for (const n of names) {
      const r = await read(path.join(folder(w), n), w);
      if (r !== undefined && sha256(JSON.stringify(r)) === n.slice(0, 64)) out.push(r);   // content addressing holds
    }
    const legacy = await read(path.join(dir, w.blockHash, w.key + '.json'), w);
    if (legacy !== undefined && out.length < maxCandidates) out.push(legacy);
    return out;
  }
  return {
    candidates,
    /** Compatibility: the first stored answer (unverified, like every cache read). */
    async get(w) { return (await candidates(w))[0]; },
    async put(w, result) {
      const body = JSON.stringify({ format: 'enclave-witness-rpc/v1', request: w.norm, result });
      const file = path.join(folder(w), sha256(JSON.stringify(result)) + '.json');
      await fs.promises.mkdir(folder(w), { recursive: true });
      const tmp = path.join(folder(w), `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
      await fs.promises.writeFile(tmp, body, { flag: 'wx' });
      try { await fs.promises.link(tmp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; } finally { await fs.promises.unlink(tmp).catch(() => {}); }
    },
  };
}

async function call(url, body, fetch, timeoutMs, maxBytes) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) { await r.body?.cancel?.().catch(() => {}); throw new Error('HTTP ' + r.status); }
  const j = JSON.parse(await readBounded(r, maxBytes));
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('malformed JSON-RPC response');
  return j;
}

function limiter(max) {
  let active = 0; const waiting = [];
  return async (fn) => {
    if (active >= max) await new Promise((r) => waiting.push(r));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  };
}

/**
 * upstreams: untrusted execution JSON-RPC URLs, tried in order. methods: a subset of WITNESS_METHODS to offer (e.g.
 * without the eth_createAccessList prefetch hint, so the verifier fetches exactly the witnesses execution touches).
 * proofs: {checker, roots} (network/witness-verify.mjs), REQUIRED when eth_getProof/eth_getCode are offered or a cache
 * is given: there is no unverified witness mode. cache: optional {put(w, result), candidates(w)} (dirWitnessCache); a
 * store with only {get, put} works, but a single-slot store can still be shadowed by a bad first write.
 * Bounds: timeoutMs per try, deadlineMs per request (all tries and checks), maxResponseBytes per answer (while
 * reading), maxInFlight upstream requests at once.
 * -> {handle(request) -> response, root(blockHash) -> binding | null, listen(port) -> url (127.0.0.1 only), close(), stats()}
 */
export function createWitnessGateway({ upstreams = [], cache = null, proofs = null, timeoutMs = 8000, deadlineMs = 30000, maxResponseBytes = 16 << 20,
  maxHeaderBytes = 1 << 20, maxInFlight = 8, fetch = globalThis.fetch, methods = WITNESS_METHODS } = {}) {
  if (!Array.isArray(methods) || methods.some((m) => !WITNESS_METHODS.includes(m))) throw new Error('methods must be a subset of WITNESS_METHODS');
  if (!Array.isArray(upstreams) || upstreams.length > 16) throw new Error('0 to 16 upstreams');
  const ids = upstreams.map((u) => rpcEndpoint(u).identity);
  if (new Set(ids).size !== ids.length) throw new Error('upstreams must be distinct endpoints');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('invalid timeoutMs');
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < timeoutMs || deadlineMs > 300000) throw new Error('invalid deadlineMs');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 64 << 20) throw new Error('invalid maxResponseBytes');
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 64) throw new Error('invalid maxInFlight');
  if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 1024 || maxHeaderBytes > maxResponseBytes) throw new Error('invalid maxHeaderBytes');
  if ((methods.some((m) => PINNED.has(m)) || cache) && !(proofs?.checker?.check && proofs?.roots?.rootFor))
    throw new Error('eth_getProof/eth_getCode and the witness cache need proofs: {checker, roots} (no unverified witness serving)');
  const stats = { upstream: Object.fromEntries(upstreams.map((u) => [rpcLabel(u), { ok: 0, failed: 0, invalid: 0, headerOk: 0, headerInvalid: 0, blockOk: 0, blockInvalid: 0, blockNull: 0 }])), cacheHits: 0, cachePuts: 0,
    cacheInvalid: 0, refused: {}, unavailable: 0, unauthenticatedBlock: 0, verifierUnavailable: 0, blocksFull: 0, blocksHeaderOnly: 0 };
  const slot = limiter(maxInFlight);
  const quarantine = new Set(), accounts = new Map();   // bounded: known-bad cache contents; recent verified account proofs
  const remember = (set, k, v) => { if (set instanceof Map) set.set(k, v); else set.add(k); if (set.size > (set instanceof Map ? 1024 : 4096)) set.delete(set.keys().next().value); };
  let server = null;
  const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const ok = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });

  async function ask(u, body, deadline, maxBytes = maxResponseBytes) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('request deadline exceeded');
    return slot(() => call(u, body, fetch, Math.max(1, Math.min(timeoutMs, left)), maxBytes));
  }

  /** An untrusted header for `hash` from the upstreams in order, checked by the helper (bound to `child` when given):
   *  -> {head, header} | null. A header that does not hash to `hash` (or does not link) costs its source the try. */
  async function headers(hash, child, deadline) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByHash', params: [hash, false] });
    for (const u of upstreams) {
      const s = stats.upstream[rpcLabel(u)];
      let j;
      try { j = await ask(u, body, deadline, maxHeaderBytes); } catch { s.failed++; continue; }
      if (j.error || !j.result) { s.failed++; continue; }
      const v = await proofs.checker.check({ op: 'header', header: j.result, expectHash: hash, child });
      if (!v.ok) { s.headerInvalid++; continue; }
      s.headerOk++;
      return { head: v, header: j.result };
    }
    return null;
  }

  /** A verified answer for a block-hash-pinned witness request -> {result} | {error}. */
  async function witness(method, params, deadline) {
    const w = witnessKey(method, params);
    if (!w) return { error: 'witness requests must be pinned by block hash', code: -32602 };
    let root;
    try { root = await proofs.roots.rootFor(w.blockHash, { headers, deadline }); } catch (e) {
      stats.verifierUnavailable++;
      return { error: `witness verifier unavailable (${String(e?.message || e).slice(0, 80)}): refused` };
    }
    if (!root) { stats.unauthenticatedBlock++; return { error: `no authenticated state root for block ${w.blockHash}: refused, not passed through` }; }
    const at = { blockHash: root.blockHash, stateRoot: root.stateRoot }, who = `${root.blockHash}:${String(params[0]).toLowerCase()}`;
    let verify;
    if (method === 'eth_getProof') {
      verify = async (result) => {
        const r = await proofs.checker.check({ op: 'getProof', ...at, params, result });
        if (r.ok) remember(accounts, who, result);
        return r;
      };
    } else {
      // code is checked against the code hash of a VERIFIED account proof for the same address and block (usually the
      // one Helios just fetched); without one the code cannot be checked, so the request is refused
      const account = accounts.get(who) ?? (await witness('eth_getProof', [params[0], [], params[1]], deadline)).result;
      if (account === undefined) return { error: 'no verified account proof for the code hash: refused' };
      verify = (result) => proofs.checker.check({ op: 'getCode', ...at, params, result, account });
    }
    const reasons = [];
    try {
      for (const c of cache ? await (cache.candidates ? cache.candidates(w) : cache.get(w).then((x) => (x === undefined ? [] : [x]))) : []) {
        const tag = `${w.key}:${sha256(JSON.stringify(c))}`;
        if (quarantine.has(tag)) continue;
        const v = await verify(c);
        if (v.ok) { stats.cacheHits++; return { result: c }; }
        remember(quarantine, tag); stats.cacheInvalid++;
      }
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
      for (const u of upstreams) {
        const s = stats.upstream[rpcLabel(u)];
        let j;
        try { j = await ask(u, body, deadline); } catch (e) { s.failed++; reasons.push(`${rpcLabel(u)}: ${String(e?.message || e).slice(0, 80)}`); continue; }
        if (j.error || !('result' in j)) { s.failed++; reasons.push(`${rpcLabel(u)}: ${String(j.error?.message ?? 'no result').slice(0, 80)}`); continue; }
        const v = await verify(j.result);
        if (!v.ok) { s.invalid++; reasons.push(`${rpcLabel(u)}: invalid witness (${String(v.error).slice(0, 80)})`); continue; }
        s.ok++;
        if (cache) await cache.put(w, j.result).then(() => { stats.cachePuts++; }, () => {});
        return { result: j.result };
      }
    } catch (e) {
      stats.verifierUnavailable++;
      return { error: `witness verifier unavailable (${String(e?.message || e).slice(0, 80)}): refused` };
    }
    return { error: `no verifiable witness${reasons.length ? ': ' + reasons.join('; ').slice(0, 400) : ' (no cached entry, no upstream)'}` };
  }

  /** eth_getBlockByHash [hash, fullTx] with proofs configured: each upstream answer is checked by the helper (`block`):
   *  the header must hash to the requested hash (the upstream's hash field is never trusted); with fullTx the body must
   *  pass Helios's OpStack::validate_block. An invalid answer costs its source the try. A hash-only (fullTx=false)
   *  answer is HEADER-verified only. Verified blocks are served as received and never cached or used as roots.
   *  null is returned only when every answering source said null and none answered with an invalid block. */
  async function blockByHash(params, deadline) {
    if (!Array.isArray(params) || params.length !== 2 || !HASH.test(params[0]) || typeof params[1] !== 'boolean')
      return { error: 'eth_getBlockByHash needs [blockHash, fullTransactions]', code: -32602 };
    const [hash, fullTx] = params, body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByHash', params });
    const reasons = [];
    let nulls = 0, invalid = 0;
    for (const u of upstreams) {
      const s = stats.upstream[rpcLabel(u)];
      let j;
      try { j = await ask(u, body, deadline); } catch (e) { s.failed++; reasons.push(`${rpcLabel(u)}: ${String(e?.message || e).slice(0, 80)}`); continue; }
      if (j.error || !('result' in j)) { s.failed++; reasons.push(`${rpcLabel(u)}: ${String(j.error?.message ?? 'no result').slice(0, 80)}`); continue; }
      if (j.result === null) { s.blockNull++; nulls++; continue; }
      let v;
      try { v = await proofs.checker.check({ op: 'block', block: j.result, expectHash: hash, fullTx }); } catch (e) {
        stats.verifierUnavailable++;
        return { error: `witness verifier unavailable (${String(e?.message || e).slice(0, 80)}): refused` };
      }
      if (!v.ok) { s.blockInvalid++; invalid++; reasons.push(`${rpcLabel(u)}: invalid block (${String(v.error).slice(0, 80)})`); continue; }
      s.blockOk++;
      if (v.body === 'full') stats.blocksFull++; else stats.blocksHeaderOnly++;
      return { result: j.result };
    }
    if (nulls && !invalid) return { result: null };
    return { error: `no verifiable block${reasons.length ? ': ' + reasons.join('; ').slice(0, 400) : ''}` };
  }

  async function handle(req) {
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return err(req?.id, -32600, 'invalid request');
    const params = req.params === undefined ? [] : req.params;
    if (!methods.includes(req.method)) { stats.refused[req.method.slice(0, 64)] = (stats.refused[req.method.slice(0, 64)] || 0) + 1; return err(req.id, -32601, 'method not offered by the witness gateway'); }
    const deadline = Date.now() + deadlineMs;
    if (req.method === 'eth_getBlockByHash' && proofs) {
      const r = await blockByHash(params, deadline);
      if ('result' in r) return ok(req.id, r.result);
      stats.unavailable++;
      return err(req.id, r.code ?? -32000, r.error);
    }
    if (PINNED.has(req.method)) {
      const r = await witness(req.method, params, deadline);
      if ('result' in r) return ok(req.id, r.result);
      stats.unavailable++;
      return err(req.id, r.code ?? -32000, r.error);
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: req.method, params });
    const broadcast = req.method === 'eth_sendRawTransaction';
    let lastError = null, sent = null;
    for (const u of upstreams) {
      const s = stats.upstream[rpcLabel(u)];
      try {
        const j = await ask(u, body, deadline);
        if (j.error) { s.failed++; lastError = j.error; continue; }
        s.ok++;
        if (!broadcast) return ok(req.id, j.result);
        sent ??= j.result;
      } catch (e) { s.failed++; lastError = { code: -32000, message: `${rpcLabel(u)}: ${String(e?.message || e).slice(0, 120)}` }; }
    }
    if (sent !== null) return ok(req.id, sent);
    stats.unavailable++;
    return err(req.id, lastError?.code ?? -32000, broadcast ? 'no upstream accepted the transaction; nothing was sent' : `no witness source answered${lastError?.message ? ': ' + String(lastError.message).slice(0, 160) : ''}`);
  }

  function onRequest(req, res) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      if (size > MAX_BODY) return;
      let parsed; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(err(null, -32700, 'parse error'))); return; }
      const out = Array.isArray(parsed) ? (parsed.length > 100 ? [err(null, -32600, 'batch too large')] : await Promise.all(parsed.map(handle))) : await handle(parsed);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  }
  async function listen(port = 0) {
    server = http.createServer(onRequest);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${server.address().port}/`;
  }
  async function close() { if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())); server = null; } }
  /** The authenticated (block hash -> state root) binding the gateway would verify witnesses against, recovering a
   *  missed block by ancestry through the upstreams; null = refused. History for that block, never freshness. */
  const root = (hash) => (proofs ? proofs.roots.rootFor(hash, { headers, deadline: Date.now() + deadlineMs }) : Promise.resolve(null));
  return { handle, root, listen, close, stats: () => structuredClone({ ...stats, quarantined: quarantine.size }) };
}
