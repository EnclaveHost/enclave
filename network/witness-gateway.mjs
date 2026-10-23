// The loopback execution endpoint a Helios verifier reads state WITNESSES from (helios --execution-rpc). Helios takes
// ONE execution URL and verifies everything it gets from it against its signed head (account/storage proofs against the
// block's state root, code against the proven code hash, receipts against the receipts root), so the sources behind
// this gateway are untrusted: any one honest, available source is enough, and none of them is a vote.
//
//   * Ordered failover over untrusted JSON-RPC upstreams (https, or plain http on loopback; network/rpc-identity.mjs).
//   * A method allowlist: only what Helios's execution provider calls (a16z/helios 2af9b418 core/src/execution/providers/
//     rpc.rs, opstack evm) plus broadcast. Anything else is refused, so the gateway is not a general RPC proxy.
//   * Witnesses Helios pins BY BLOCK HASH (eth_getProof, eth_getCode with {blockHash}) are immutable: they may be kept in
//     an immutable cache and served from it when every upstream fails. A cache hit is availability for THAT block only -
//     never freshness: the verifier still needs a fresh signed head, and Helios rejects a witness that does not match it.
//     Cache entries are create-only, and a wrong entry costs nothing but a failed verification.
//   * eth_sendRawTransaction goes to every upstream. A broadcast proves nothing about inclusion (a receipt in a verified
//     block does), and with every upstream down nothing can be sent: the gateway says so.
// No P2P witness transport exists for Base today (rpc-peer-audit RESULT §2: snap/2 off by default, no flag; GetNodeData
// empty), so none is offered; a future transport is one more entry in `upstreams` behind the same interface.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { rpcEndpoint, rpcLabel } from './rpc-identity.mjs';

export const WITNESS_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getProof', 'eth_getCode',
  'eth_createAccessList', 'eth_getBlockReceipts', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_sendRawTransaction']);
const PINNED = new Set(['eth_getProof', 'eth_getCode']);
const MAX_BODY = 1 << 20, MAX_RESPONSE = 16 << 20, HASH = /^0x[0-9a-fA-F]{64}$/;

/** The cache key of a block-hash-pinned witness request, or null when the request is not immutable. */
export function witnessKey(method, params) {
  if (!PINNED.has(method) || !Array.isArray(params) || !params.length) return null;
  const at = params[params.length - 1];
  if (!at || typeof at !== 'object' || Array.isArray(at) || !HASH.test(at.blockHash || '') || Object.keys(at).some((k) => k !== 'blockHash' && k !== 'requireCanonical')) return null;
  const norm = JSON.stringify([method, JSON.parse(JSON.stringify(params).toLowerCase())]);
  return { key: createHash('sha256').update(norm).digest('hex'), blockHash: at.blockHash.toLowerCase(), norm };
}

/** Create-only directory cache of block-hash-pinned witnesses: <dir>/<blockHash>/<sha256(request)>.json. */
export function dirWitnessCache(dir) {
  const file = (w) => path.join(dir, w.blockHash, w.key + '.json');
  return {
    async get(w) {
      try {
        const e = JSON.parse(await fs.promises.readFile(file(w), 'utf8'));
        return e?.format === 'enclave-witness-rpc/v1' && e.request === w.norm ? e.result : undefined;
      } catch { return undefined; }
    },
    async put(w, result) {
      await fs.promises.mkdir(path.dirname(file(w)), { recursive: true });
      try { await fs.promises.writeFile(file(w), JSON.stringify({ format: 'enclave-witness-rpc/v1', request: w.norm, result }), { flag: 'wx' }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    },
  };
}

async function call(url, body, fetch, timeoutMs) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const text = await r.text();
  if (text.length > MAX_RESPONSE) throw new Error('response too large');
  const j = JSON.parse(text);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('malformed JSON-RPC response');
  return j;
}

/**
 * upstreams: untrusted execution JSON-RPC URLs, tried in order. cache: optional {get(w), put(w, result)} (dirWitnessCache).
 * -> {handle(request) -> response, listen(port) -> url (127.0.0.1 only), close(), stats()}
 */
export function createWitnessGateway({ upstreams = [], cache = null, timeoutMs = 8000, fetch = globalThis.fetch } = {}) {
  if (!Array.isArray(upstreams) || upstreams.length > 16) throw new Error('0 to 16 upstreams');
  const ids = upstreams.map((u) => rpcEndpoint(u).identity);
  if (new Set(ids).size !== ids.length) throw new Error('upstreams must be distinct endpoints');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('invalid timeoutMs');
  const stats = { upstream: Object.fromEntries(upstreams.map((u) => [rpcLabel(u), { ok: 0, failed: 0 }])), cacheHits: 0, cachePuts: 0, refused: {}, unavailable: 0 };
  let server = null;
  const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  async function handle(req) {
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return err(req?.id, -32600, 'invalid request');
    const params = req.params === undefined ? [] : req.params;
    if (!WITNESS_METHODS.includes(req.method)) { stats.refused[req.method.slice(0, 64)] = (stats.refused[req.method.slice(0, 64)] || 0) + 1; return err(req.id, -32601, 'method not offered by the witness gateway'); }
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: req.method, params });
    const w = cache ? witnessKey(req.method, params) : null;
    const broadcast = req.method === 'eth_sendRawTransaction';
    let lastError = null, sent = null;
    for (const u of upstreams) {
      const s = stats.upstream[rpcLabel(u)];
      try {
        const j = await call(u, body, fetch, timeoutMs);
        if (j.error) { s.failed++; lastError = j.error; continue; }
        s.ok++;
        if (w) cache.put(w, j.result).then(() => { stats.cachePuts++; }, () => {});
        if (!broadcast) return { jsonrpc: '2.0', id: req.id ?? null, result: j.result };
        sent ??= j.result;
      } catch (e) { s.failed++; lastError = { code: -32000, message: `${rpcLabel(u)}: ${String(e?.message || e).slice(0, 120)}` }; }
    }
    if (sent !== null) return { jsonrpc: '2.0', id: req.id ?? null, result: sent };
    if (w) {
      const hit = await cache.get(w);
      if (hit !== undefined) { stats.cacheHits++; return { jsonrpc: '2.0', id: req.id ?? null, result: hit }; }
    }
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
  return { handle, listen, close, stats: () => structuredClone(stats) };
}
