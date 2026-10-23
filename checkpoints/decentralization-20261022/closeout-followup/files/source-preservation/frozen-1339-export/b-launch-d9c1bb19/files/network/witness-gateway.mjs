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
//   * An optional ARCHIVE tier (a remote store such as Sia-S3: network/s3-witness-cache.mjs) is the last resort: it is
//     read only after the local cache and every upstream failed, within the request's remaining deadline, and each
//     candidate is verified and quarantined exactly like a cache entry. It receives only VERIFIED upstream answers,
//     and those writes are never awaited, so a slow or hung remote store can neither delay nor fail a fresh read.
//     It also keeps the headers that ancestry recovery VERIFIED (keyed by their own block hash), and offers them, again
//     checked by the helper against the hash and the bound child, only when every upstream failed to give one: a
//     missed block's root can then be recovered with every upstream down. Roots still come only from a signed head and
//     hash links below it; the archive is never an authority for a root or for freshness.
//   * Other methods (blocks by number, receipts, logs, fee data) keep ordered first-answer failover: Helios verifies
//     those against its signed head itself. A method allowlist keeps the gateway from being a general RPC proxy
//     (a16z/helios 2af9b418 core/src/execution/providers/rpc.rs, opstack evm, plus broadcast).
//   * eth_sendRawTransaction goes to every upstream. A broadcast proves nothing about inclusion (a receipt in a verified
//     block does), and with every upstream down nothing can be sent: the gateway says so.
//   * Bounds: request body, upstream response bytes (enforced while reading), per-try timeout, one total deadline per
//     request, batch size and upstream requests in flight.
// No P2P witness transport is offered: on the pinned/current Base client releases audited (rpc-peer-audit RESULT §2) the
// state-serving protocol is disabled by default with no flag to enable it (snap/2 off; GetNodeData empty), and no enabled,
// supported P2P proof path was observed. Custom peers that serve state were not ruled out. A future transport would be
// one more entry in `upstreams` behind the same interface. Failover
// between sources is NOT independence from them: with every fresh witness source down, only cached history remains.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { rpcEndpoint, rpcLabel } from './rpc-identity.mjs';
import { abortable, readBounded } from './witness-verify.mjs';

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
export function dirWitnessCache(dir, { maxCandidates = 32, maxEntryBytes = 16 << 20, maxBytes = 1 << 30 } = {}) {
  // maxBytes: THIS cache's share of the central storage budget for the host's caches (allocated bytes, including
  // directories and the transient temp file of a write). It is a configured limit, not a device reservation: the
  // storage owner enforces the aggregate device budget. Over the limit, writes are skipped (create-only: nothing is
  // evicted or rewritten) and reads continue. Default 1 GiB; a deployment sets it from the central budget.
  if (!Number.isSafeInteger(maxBytes) || maxBytes < (1 << 20)) throw new Error('invalid maxBytes (this cache\'s share of the central storage budget, in bytes)');
  const folder = (w) => path.join(dir, w.blockHash, w.key);
  const budget = { used: null, skipped: 0 };
  const alloc = (bytes) => Math.ceil(bytes / 4096) * 4096;
  /** Allocated bytes under dir now (bounded walk; past 1,000,000 entries the cache counts as full). */
  function measure() {
    let used = 0, seen = 0;
    const walk = (d) => {
      let names; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const n of names) {
        if (++seen > 1e6) { used = Infinity; return; }
        const f = path.join(d, n.name);
        try { const st = fs.lstatSync(f); used += st.blocks ? st.blocks * 512 : alloc(st.size); } catch { continue; }
        if (n.isDirectory()) walk(f);
        if (used === Infinity) return;
      }
    };
    walk(dir);
    return used;
  }
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
    usage() { return { usedBytes: budget.used ?? measure(), maxBytes, skippedOverBudget: budget.skipped }; },
    async put(w, result) {
      const body = JSON.stringify({ format: 'enclave-witness-rpc/v1', request: w.norm, result });
      budget.used ??= measure();
      // entry + its transient temp copy + a possibly new request directory and block directory
      const cost = 2 * alloc(Buffer.byteLength(body)) + 2 * 4096;
      if (budget.used + cost > maxBytes) { budget.skipped++; return; }
      budget.used += cost - alloc(Buffer.byteLength(body));            // the temp copy is removed again
      const file = path.join(folder(w), sha256(JSON.stringify(result)) + '.json');
      await fs.promises.mkdir(folder(w), { recursive: true });
      const tmp = path.join(folder(w), `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
      await fs.promises.writeFile(tmp, body, { flag: 'wx' });
      try { await fs.promises.link(tmp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; } finally { await fs.promises.unlink(tmp).catch(() => {}); }
    },
  };
}

async function call(url, body, fetch, signal, timeoutMs, maxBytes) {
  // the request's own signal (deadline, gateway close) AND this try's timeout: aborting also cancels the body read
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', credentials: 'omit',
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
  if (!r.ok) { await r.body?.cancel?.().catch(() => {}); throw new Error('HTTP ' + r.status); }
  const j = JSON.parse(await readBounded(r, maxBytes));
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('malformed JSON-RPC response');
  return j;
}

/** At most `max` upstream requests at once, FIFO, at most `maxQueued` waiting. A waiter whose signal aborts is removed
 *  from the queue at once (it never reaches an upstream). A slot is released only when the underlying work settles,
 *  so a source that ignores abort still counts against `max`; its caller has already been answered (abort) and the
 *  late result is discarded. */
function limiter(max, maxQueued) {
  let active = 0; const waiting = [];
  const release = () => {
    active--;
    const w = waiting.shift();
    if (w) { w.signal.removeEventListener('abort', w.onAbort); active++; w.grant(); }
  };
  async function run(fn, signal) {
    if (signal.aborted) throw signal.reason;
    if (active >= max) {
      if (waiting.length >= maxQueued) throw new Error('gateway busy: upstream queue full');
      await new Promise((grant, fail) => {
        const w = { grant, signal };
        w.onAbort = () => { const i = waiting.indexOf(w); if (i >= 0) waiting.splice(i, 1); fail(signal.reason); };
        signal.addEventListener('abort', w.onAbort, { once: true });
        waiting.push(w);
      });
    } else active++;
    let work;
    try { work = Promise.resolve(fn()); } catch (e) { release(); throw e; }
    work.then(release, release);
    return abortable(work, signal);
  }
  return { run, stats: () => ({ active, queued: waiting.length }) };
}

/**
 * upstreams: untrusted execution JSON-RPC URLs, tried in order. methods: a subset of WITNESS_METHODS to offer (e.g.
 * without the eth_createAccessList prefetch hint, so the verifier fetches exactly the witnesses execution touches).
 * proofs: {checker, roots} (network/witness-verify.mjs), REQUIRED when eth_getProof/eth_getCode are offered or a cache
 * is given: there is no unverified witness mode. cache: optional {put(w, result), candidates(w)} (dirWitnessCache); a
 * store with only {get, put} works, but a single-slot store can still be shadowed by a bad first write.
 * archive: optional {candidates(w, {deadline, signal}), put(w, result)} (s3WitnessCache): read only after the cache and every
 * upstream failed, written only with verified answers (witnesses, and headers checked for ancestry) and never awaited.
 * Bounds: deadlineMs per request covers EVERYTHING the request does (queue wait for a slot, every upstream try and body
 * read, root recovery, helper checks, the cache read); timeoutMs per try (cut to what is left of the deadline when the
 * slot is granted; no try starts with less than minTryMs left); maxResponseBytes per answer (while reading);
 * maxInFlight upstream requests at once, maxQueued waiting (more: refused at once); cacheTimeoutMs per cache read (a
 * slow cache is skipped, not waited out); maxCacheOps concurrent cache reads and background writes.
 * Cache interface (optional arguments, compatible with {get, put} / {candidates, put}): candidates(w, {signal}),
 * get(w, {signal}), put(w, result, {signal}). Writes run in the background (a read never waits for one); settled()
 * resolves when the writes started so far have settled.
 * -> {handle(request) -> response, root(blockHash) -> binding | null, listen(port) -> url (127.0.0.1 only), close()
 *    (terminal), settled(), stats()}
 */
export function createWitnessGateway({ upstreams = [], cache = null, archive = null, proofs = null, timeoutMs = 8000, deadlineMs = 30000, maxResponseBytes = 16 << 20,
  maxHeaderBytes = 1 << 20, maxInFlight = 8, maxQueued = 256, minTryMs = 25, cacheTimeoutMs = Math.min(1000, deadlineMs), maxCacheOps = 64, fetch = globalThis.fetch, methods = WITNESS_METHODS } = {}) {
  if (!Array.isArray(methods) || methods.some((m) => !WITNESS_METHODS.includes(m))) throw new Error('methods must be a subset of WITNESS_METHODS');
  if (!Array.isArray(upstreams) || upstreams.length > 16) throw new Error('0 to 16 upstreams');
  const ids = upstreams.map((u) => rpcEndpoint(u).identity);
  if (new Set(ids).size !== ids.length) throw new Error('upstreams must be distinct endpoints');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('invalid timeoutMs');
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < timeoutMs || deadlineMs > 300000) throw new Error('invalid deadlineMs');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 64 << 20) throw new Error('invalid maxResponseBytes');
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 64) throw new Error('invalid maxInFlight');
  if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 1024 || maxHeaderBytes > maxResponseBytes) throw new Error('invalid maxHeaderBytes');
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 4096) throw new Error('invalid maxQueued');
  if (!Number.isSafeInteger(minTryMs) || minTryMs < 1 || minTryMs > timeoutMs) throw new Error('invalid minTryMs');
  if (!Number.isSafeInteger(cacheTimeoutMs) || cacheTimeoutMs < 10 || cacheTimeoutMs > deadlineMs) throw new Error('invalid cacheTimeoutMs');
  if (!Number.isSafeInteger(maxCacheOps) || maxCacheOps < 1 || maxCacheOps > 1024) throw new Error('invalid maxCacheOps');
  if (archive && !(typeof archive.candidates === 'function' && typeof archive.put === 'function')) throw new Error('archive needs candidates(w) and put(w, result)');
  if ((methods.some((m) => PINNED.has(m)) || cache || archive) && !(proofs?.checker?.check && proofs?.roots?.rootFor))
    throw new Error('eth_getProof/eth_getCode and the witness cache need proofs: {checker, roots} (no unverified witness serving)');
  const stats = { upstream: Object.fromEntries(upstreams.map((u) => [rpcLabel(u), { ok: 0, failed: 0, invalid: 0, headerOk: 0, headerInvalid: 0, blockOk: 0, blockInvalid: 0, blockNull: 0 }])), cacheHits: 0, cachePuts: 0,
    cacheInvalid: 0, archiveHits: 0, archiveInvalid: 0, archiveHeaderHits: 0, archiveHeaderInvalid: 0, archiveQueued: 0, archiveErrors: 0, refused: {}, unavailable: 0, unauthenticatedBlock: 0, verifierUnavailable: 0, blocksFull: 0, blocksHeaderOnly: 0,
    deadlineExceeded: 0, queueFull: 0, cacheTimeouts: 0, cacheSkipped: 0, cachePutSkipped: 0, closedRefusals: 0 };
  const slot = limiter(maxInFlight, maxQueued);
  const life = new AbortController();                     // gateway lifetime: close() aborts every request and walk
  let closed = false, cacheOps = 0;
  const puts = new Set();                                 // background cache writes (never awaited by a read)
  class Deadline extends Error {}
  /** One request's operation context: aborted at its deadline or when the gateway closes. */
  function newOp() {
    const ac = new AbortController(), deadline = Date.now() + deadlineMs;
    const timer = setTimeout(() => ac.abort(new Deadline('request deadline exceeded')), deadlineMs);
    return { signal: AbortSignal.any([ac.signal, life.signal]), deadline, done: () => clearTimeout(timer) };
  }
  // expiry is by time as well as by signal: a try's timeout or a slot handoff in the same millisecond as the deadline
  // timer is still the deadline
  const expired = (op) => op.signal.aborted || Date.now() >= op.deadline;
  const ended = (op) => op.signal.reason ?? new Deadline('request deadline exceeded');
  /** A cache read bounded by its own budget and the request: a hung or slow cache is skipped, never waited out. */
  async function cacheRead(w, op) {
    if (!cache) return [];
    if (cacheOps >= maxCacheOps) { stats.cacheSkipped++; return []; }
    const signal = AbortSignal.any([op.signal, AbortSignal.timeout(cacheTimeoutMs)]);
    cacheOps++;
    const read = Promise.resolve().then(() => (cache.candidates ? cache.candidates(w, { signal }) : cache.get(w, { signal }).then((x) => (x === undefined ? [] : [x]))));
    read.then(() => { cacheOps--; }, () => { cacheOps--; });
    try { return await abortable(read, signal); } catch (e) {
      if (expired(op)) throw ended(op);
      if (signal.aborted) { stats.cacheTimeouts++; return []; }
      return [];                                          // an erroring cache is just a miss
    }
  }
  /** A verified answer goes to the cache in the background (bounded); a read never waits for or fails on a write. */
  function cacheWrite(w, result) {
    if (!cache || closed) return;
    if (puts.size >= maxCacheOps) { stats.cachePutSkipped++; return; }
    const put = Promise.resolve().then(() => cache.put(w, result, { signal: life.signal })).then(() => { stats.cachePuts++; }, () => {});
    puts.add(put); put.finally(() => puts.delete(put));
  }
  const quarantine = new Set(), accounts = new Map();   // bounded: known-bad cache contents; recent verified account proofs
  const remember = (set, k, v) => { if (set instanceof Map) set.set(k, v); else set.add(k); if (set.size > (set instanceof Map ? 1024 : 4096)) set.delete(set.keys().next().value); };
  let server = null;
  /** Queue a VERIFIED answer for the archive; never awaited, never throws (a slow or hung store cannot delay a read). */
  function archivePut(w, result) {
    if (closed) return;                                    // a late write after close() never reaches the archive
    stats.archiveQueued++;
    try { Promise.resolve(archive.put(w, result)).catch(() => { stats.archiveErrors++; }); } catch { stats.archiveErrors++; }
  }
  /** The archive's UNVERIFIED candidates for w within `op` (a request, or a shared ancestry walk): at most 64; [] when
   *  the archive fails or is busy. The read carries op's signal, so when op ends (its deadline, its last caller leaving,
   *  or close) the archive drops op's queued slot and kills op's S3 transfers; other ops' reads continue. Counted
   *  against the same aggregate maxCacheOps bound as local cache reads. An expired op is a deadline, never a miss. */
  async function archived(w, op) {
    if (expired(op)) throw ended(op);
    if (cacheOps >= maxCacheOps) { stats.cacheSkipped++; return []; }
    cacheOps++;
    const read = Promise.resolve().then(() => archive.candidates(w, { deadline: op.deadline, signal: op.signal }));
    read.then(() => { cacheOps--; }, () => { cacheOps--; });
    try {
      const list = await abortable(read, op.signal);
      if (expired(op)) throw ended(op);
      return Array.isArray(list) ? list.slice(0, 64) : [];
    } catch (e) { if (expired(op)) throw ended(op); stats.archiveErrors++; return []; }
  }
  /** The archive key of a block header: pinned by the block's own hash, like a witness request. */
  const headerKey = (hash) => {
    const h = String(hash).toLowerCase(), norm = JSON.stringify(['eth_getBlockByHash', [h, false]]);
    return { key: sha256(norm), blockHash: h, norm };
  };
  const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const ok = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });

  /** One upstream try for `op`: queued for a slot (removed if `op` aborts while waiting), then timed with what is left
   *  of the request's deadline WHEN THE SLOT IS GRANTED; nothing is sent once the deadline has passed, or with less than
   *  minTryMs of it left (a try that cannot finish is not started). */
  async function ask(u, body, op, maxBytes = maxResponseBytes) {
    try {
      return await slot.run(() => {
        const left = op.deadline - Date.now();
        if (left < minTryMs || op.signal.aborted) throw new Deadline('request deadline exceeded');
        return call(u, body, fetch, op.signal, Math.min(timeoutMs, left), maxBytes);
      }, op.signal);
    } catch (e) { if (String(e?.message).includes('queue full')) stats.queueFull++; throw e; }
  }

  /** An untrusted header for `hash` from the upstreams in order, checked by the helper (bound to `child` when given):
   *  -> {head, header} | null. A header that does not hash to `hash` (or does not link) costs its source the try. */
  async function headers(hash, child, op) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByHash', params: [hash, false] });
    for (const u of upstreams) {
      if (op.signal.aborted) return null;
      const s = stats.upstream[rpcLabel(u)];
      let j;
      try { j = await ask(u, body, op, maxHeaderBytes); } catch { s.failed++; continue; }
      if (j.error || !j.result) { s.failed++; continue; }
      const v = await proofs.checker.check({ op: 'header', header: j.result, expectHash: hash, child }, { signal: op.signal });
      if (!v.ok) { s.headerInvalid++; continue; }
      s.headerOk++;
      if (archive) archivePut(headerKey(hash), j.result);
      return { head: v, header: j.result };
    }
    // every upstream failed: an archived header, checked by the helper exactly like an upstream's
    if (archive) {
      const k = headerKey(hash);
      for (const c of await archived(k, op)) {
        if (Date.now() >= op.deadline) break;
        const tag = `${k.key}:${sha256(JSON.stringify(c))}`;
        if (quarantine.has(tag)) continue;
        const v = await proofs.checker.check({ op: 'header', header: c, expectHash: hash, child }, { signal: op.signal });
        if (v.ok) { stats.archiveHeaderHits++; return { head: v, header: c }; }
        remember(quarantine, tag); stats.archiveHeaderInvalid++;
      }
    }
    return null;
  }

  /** A verified answer for a block-hash-pinned witness request -> {result} | {error}. */
  async function witness(method, params, op) {
    const w = witnessKey(method, params);
    if (!w) return { error: 'witness requests must be pinned by block hash', code: -32602 };
    let root;
    try { root = await proofs.roots.rootFor(w.blockHash, { headers, deadline: op.deadline, signal: op.signal }); } catch (e) {
      if (expired(op)) throw ended(op);
      stats.verifierUnavailable++;
      return { error: `witness verifier unavailable (${String(e?.message || e).slice(0, 80)}): refused` };
    }
    if (!root) { stats.unauthenticatedBlock++; return { error: `no authenticated state root for block ${w.blockHash}: refused, not passed through` }; }
    const at = { blockHash: root.blockHash, stateRoot: root.stateRoot }, who = `${root.blockHash}:${String(params[0]).toLowerCase()}`;
    let verify;
    if (method === 'eth_getProof') {
      verify = async (result) => {
        const r = await proofs.checker.check({ op: 'getProof', ...at, params, result }, { signal: op.signal });
        if (r.ok) remember(accounts, who, result);
        return r;
      };
    } else {
      // code is checked against the code hash of a VERIFIED account proof for the same address and block (usually the
      // one Helios just fetched); without one the code cannot be checked, so the request is refused
      const account = accounts.get(who) ?? (await witness('eth_getProof', [params[0], [], params[1]], op)).result;
      if (account === undefined) return { error: 'no verified account proof for the code hash: refused' };
      verify = (result) => proofs.checker.check({ op: 'getCode', ...at, params, result, account }, { signal: op.signal });
    }
    const reasons = [];
    try {
      for (const c of await cacheRead(w, op)) {
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
        if (expired(op)) throw ended(op);
        try { j = await ask(u, body, op); } catch (e) { if (expired(op)) throw ended(op); s.failed++; reasons.push(`${rpcLabel(u)}: ${String(e?.message || e).slice(0, 80)}`); continue; }
        if (j.error || !('result' in j)) { s.failed++; reasons.push(`${rpcLabel(u)}: ${String(j.error?.message ?? 'no result').slice(0, 80)}`); continue; }
        const v = await verify(j.result);
        if (!v.ok) { s.invalid++; reasons.push(`${rpcLabel(u)}: invalid witness (${String(v.error).slice(0, 80)})`); continue; }
        s.ok++;
        cacheWrite(w, j.result);
        if (archive) archivePut(w, j.result);   // verified; NOT awaited: a slow or hung archive must not delay the fresh answer
        return { result: j.result };
      }
      // last resort: the archive, inside the remaining deadline; every candidate verified like a cache entry
      if (archive) {
        const found = await archived(w, op);
        for (const c of found) {
          if (Date.now() >= op.deadline) break;
          const tag = `${w.key}:${sha256(JSON.stringify(c))}`;
          if (quarantine.has(tag)) continue;
          const v = await verify(c);
          if (v.ok) { stats.archiveHits++; return { result: c }; }
          remember(quarantine, tag); stats.archiveInvalid++;
        }
        if (!found.length) reasons.push('archive: no candidate');
      }
    } catch (e) {
      if (expired(op)) throw ended(op);
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
  async function blockByHash(params, op) {
    if (!Array.isArray(params) || params.length !== 2 || !HASH.test(params[0]) || typeof params[1] !== 'boolean')
      return { error: 'eth_getBlockByHash needs [blockHash, fullTransactions]', code: -32602 };
    const [hash, fullTx] = params, body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByHash', params });
    const reasons = [];
    let nulls = 0, invalid = 0;
    for (const u of upstreams) {
      const s = stats.upstream[rpcLabel(u)];
      let j;
      if (expired(op)) throw ended(op);
      try { j = await ask(u, body, op); } catch (e) { if (expired(op)) throw ended(op); s.failed++; reasons.push(`${rpcLabel(u)}: ${String(e?.message || e).slice(0, 80)}`); continue; }
      if (j.error || !('result' in j)) { s.failed++; reasons.push(`${rpcLabel(u)}: ${String(j.error?.message ?? 'no result').slice(0, 80)}`); continue; }
      if (j.result === null) { s.blockNull++; nulls++; continue; }
      let v;
      try { v = await proofs.checker.check({ op: 'block', block: j.result, expectHash: hash, fullTx }, { signal: op.signal }); } catch (e) {
        if (expired(op)) throw ended(op);
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

  /** One request under one operation context: every queue wait, upstream try, cache read, root recovery and helper
   *  check is bounded by its deadline, and no success is returned once it has passed. */
  async function handle(req) {
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return err(req?.id, -32600, 'invalid request');
    const params = req.params === undefined ? [] : req.params;
    if (!methods.includes(req.method)) { stats.refused[req.method.slice(0, 64)] = (stats.refused[req.method.slice(0, 64)] || 0) + 1; return err(req.id, -32601, 'method not offered by the witness gateway'); }
    if (closed) { stats.closedRefusals++; return err(req.id, -32000, 'witness gateway closed'); }
    const op = newOp();
    let sentTo = 0;
    try {
      const r = await serve(req.method, params, op, () => { sentTo++; });
      if (expired(op)) throw ended(op);            // never a success after the deadline (or after close)
      if ('result' in r) return ok(req.id, r.result);
      stats.unavailable++;
      return err(req.id, r.code ?? -32000, r.error);
    } catch (e) {
      if (!expired(op)) throw e;
      if (closed) { stats.closedRefusals++; return err(req.id, -32000, 'witness gateway closed: refused'); }
      stats.deadlineExceeded++;
      return err(req.id, -32000, req.method === 'eth_sendRawTransaction' && sentTo
        ? `request deadline exceeded after the transaction reached ${sentTo} upstream(s); no result is returned` : 'request deadline exceeded: refused');
    } finally { op.done(); }
  }
  async function serve(method, params, op, onSent) {
    if (method === 'eth_getBlockByHash' && proofs) return blockByHash(params, op);
    if (PINNED.has(method)) return witness(method, params, op);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const broadcast = method === 'eth_sendRawTransaction';
    let lastError = null, sent = null;
    for (const u of upstreams) {
      if (expired(op)) throw ended(op);            // no new upstream request (and no new broadcast) after the deadline
      const s = stats.upstream[rpcLabel(u)];
      try {
        const j = await ask(u, body, op);
        if (broadcast) onSent();
        if (j.error) { s.failed++; lastError = j.error; continue; }
        s.ok++;
        if (!broadcast) return { result: j.result };
        sent ??= j.result;
      } catch (e) {
        if (expired(op)) throw ended(op);
        s.failed++; lastError = { code: -32000, message: `${rpcLabel(u)}: ${String(e?.message || e).slice(0, 120)}` };
      }
    }
    if (sent !== null) return { result: sent };
    return { error: broadcast ? 'no upstream accepted the transaction; nothing was sent' : `no witness source answered${lastError?.message ? ': ' + String(lastError.message).slice(0, 160) : ''}`, code: lastError?.code ?? -32000 };
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
  /** TERMINAL: every queued and running request is aborted (queued ones never reach an upstream), new requests are
   *  refused, the HTTP endpoint closes, and background cache writes get at most 1 s to settle. The checker and root
   *  store are the caller's (they may be shared) and are not closed here. */
  async function close() {
    closed = true;
    life.abort(new Error('witness gateway closed'));
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())); server = null; }
    await Promise.race([settled(), new Promise((r) => setTimeout(r, 1000).unref?.())]);
  }
  /** Resolves when the background cache writes started so far have settled. */
  const settled = () => Promise.allSettled([...puts]).then(() => {});
  /** The authenticated (block hash -> state root) binding the gateway would verify witnesses against, recovering a
   *  missed block by ancestry through the upstreams; null = refused. History for that block, never freshness. */
  async function root(hash) {
    if (!proofs || closed) return null;
    const op = newOp();
    try { return await proofs.roots.rootFor(hash, { headers, deadline: op.deadline, signal: op.signal }); }
    catch (e) { if (expired(op)) return null; throw e; } finally { op.done(); }
  }
  return { handle, root, listen, close, settled,
    stats: () => structuredClone({ ...stats, quarantined: quarantine.size, ...slot.stats(), cacheReads: cacheOps, cacheWrites: puts.size, closed }) };
}
