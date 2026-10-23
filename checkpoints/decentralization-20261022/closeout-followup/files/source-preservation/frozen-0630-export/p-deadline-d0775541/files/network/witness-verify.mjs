// What the witness gateway (network/witness-gateway.mjs) needs to tell a VALID witness from an invalid one before it
// serves or caches it, without trusting any witness source:
//
//   * createWitnessChecker: a client of `witness-check`, a small native helper built from the patched Helios fork
//     (opstack/bin/witness-check.rs, branch enclave-witness-check). Every check is Helios's own code: the sequencer
//     commitment signature + payload conversion its opstack consensus client applies, and the account/storage MPT
//     proof and code-hash checks its execution provider applies, plus exact request binding. No crypto is reimplemented
//     here. The helper is offline, holds only the pinned signer and chain id, and answers one JSON line per request.
//   * createRootStore: authenticated (block hash -> state root) bindings, taken ONLY from signed sequencer commitments
//     read from the consensus head API (GET <consensusUrl>/latest: the same source and API Helios's --consensus-rpc
//     reads) and verified by the helper. Never from an execution/witness source, and never from Helios: the gateway
//     serves Helios, so asking Helios for roots would be circular.
//     A root is a binding for THAT block only. It says nothing about freshness: a block-hash-pinned witness is history,
//     and Helios's own head checks (check_head_age) decide what is fresh.
//   * readBounded: an HTTP body read that stops at a byte limit WHILE reading.
import { spawn } from 'node:child_process';
import { rpcEndpoint } from './rpc-identity.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Read a fetch Response body as text, refusing (and cancelling the stream) as soon as it exceeds maxBytes. */
export async function readBounded(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel?.().catch(() => {}); throw new Error('response too large'); }
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('response has no readable body stream');
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new Error('response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), size).toString('utf8');
}

/** Settle with `promise`, or reject with signal.reason as soon as `signal` aborts (the listener is always removed).
 *  The underlying work is NOT stopped by this; callers pass the signal to the work itself where the interface allows. */
export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { promise.catch?.(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/**
 * bin: the witness-check executable; chainId, signer: the pinned chain and unsafe-block signer (the same pins Helios is
 * given). -> {check(request, {signal}) -> {ok, ...}, close()}. A check that cannot complete (helper missing, crashed,
 * over timeoutMs, queue full, closed) REJECTS: the caller must refuse, never treat it as a pass. After a crash or a
 * hang the helper is restarted on next use; close() is TERMINAL (no restart, every later check rejects).
 * Per-request cancellation with one shared helper: an aborted `signal` drops only THAT check (its pending entry and
 * timer; a late reply is ignored). The helper answers requests in order, so a check already written still costs the
 * helper its (bounded) work, but no other caller's check is failed by one caller's abort.
 */
export function createWitnessChecker({ bin, chainId, signer, timeoutMs = 10000, maxPending = 256, maxRequestBytes = 48 << 20 } = {}) {
  if (typeof bin !== 'string' || !bin) throw new Error('witness-check binary path required');
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('chainId required');
  if (!/^0x[0-9a-fA-F]{40}$/.test(signer || '')) throw new Error('signer address required');
  let child = null, buffer = '', seq = 0, closed = false;
  const pending = new Map();
  const settle = (id, p) => { pending.delete(id); clearTimeout(p.timer); p.signal?.removeEventListener('abort', p.onAbort); };
  const failAll = (why) => { for (const [id, p] of [...pending]) { settle(id, p); p.reject(new Error(why)); } };
  function start() {
    const c = spawn(bin, ['--chain-id', String(chainId), '--signer', signer], { stdio: ['pipe', 'pipe', 'ignore'] });
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d) => {
      if (child !== c) return;                              // output of a helper already replaced or closed
      buffer += d;
      if (buffer.length > 1 << 20) { failAll('witness verifier output too long'); c.kill('SIGKILL'); return; }
      for (let i; (i = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        let reply; try { reply = JSON.parse(line); } catch { continue; }
        const p = pending.get(reply.id);
        if (!p) continue;                                   // aborted or timed out: the late reply is ignored
        settle(reply.id, p); p.resolve(reply);
      }
    });
    c.stdin.on('error', () => {});
    c.on('error', () => {});
    c.on('exit', () => { if (child === c) { child = null; buffer = ''; failAll('witness verifier exited'); } });
    return c;
  }
  async function check(request, { signal } = {}) {
    if (closed) throw new Error('witness verifier closed');
    if (signal?.aborted) throw signal.reason;
    if (pending.size >= maxPending) throw new Error('witness verifier queue full');
    const id = ++seq;
    const line = JSON.stringify({ ...request, id }) + '\n';
    if (Buffer.byteLength(line) > maxRequestBytes) throw new Error('witness check request too large');
    child ??= start();
    const c = child;
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, signal };
      p.timer = setTimeout(() => {
        // a hung verifier is killed: every pending check fails (callers refuse) and the next check restarts it
        if (child === c) { child = null; buffer = ''; }
        failAll('witness verifier timed out'); c.kill('SIGKILL');
      }, timeoutMs);
      p.onAbort = () => { if (pending.get(id) === p) { settle(id, p); reject(signal.reason); } };
      signal?.addEventListener('abort', p.onAbort, { once: true });
      pending.set(id, p);
      c.stdin.write(line);
    });
  }
  function close() { closed = true; const c = child; child = null; buffer = ''; failAll('witness verifier closed'); c?.kill('SIGKILL'); }
  return { check, close, stats: () => ({ pending: pending.size, running: child !== null, closed }) };
}

/**
 * checker: createWitnessChecker. consensusUrl: the consensus head API (https, or http on loopback); optional when heads
 * are pushed with offer(). -> {rootFor(hash, {headers, deadline, signal}), offer(commitment, {signal}), addCommitment
 * (= offer), refresh(), start(pollMs), stop(), close(), stats()}.
 *
 * Two ways a (block hash -> state root) binding enters the store, both verified by the helper:
 *   * 'signed-head': a sequencer commitment (polled from consensusUrl, or pushed with offer() by a head source such as
 *     the native gossip bridge) that recovers to the pinned signer.
 *   * 'ancestor': an UNTRUSTED header (from `headers`, e.g. the gateway's execution upstreams) whose alloy hash_slow()
 *     equals the parent hash of an already bound child, one block lower and not later (helper op `header`). Walking
 *     down from the nearest bound descendant recovers a block the store never saw (a poll gap, a cold start, a
 *     confirmed block older than the first head seen). A source's claim about a hash is never taken as is.
 * rootFor(hash) without a binding: poll once (coalesced), then, given `headers(hash, child, deadline)` -> {head,
 * header} | null, recover by ancestry: the requested header is fetched first only to learn its claimed number, the
 * walk goes down from the nearest bound block above that number (at most maxAncestry links), and the requested hash is
 * bound only if the walk arrives at its child and that child's parent hash IS the requested hash. Otherwise (unavailable
 * history, too deep, newer than every bound head, a fork/orphan, a deadline) the answer is null: the caller refuses.
 * A binding is history for that block, never freshness (Helios's own head checks decide what is fresh). Concurrent
 * recoveries of one hash share one walk. At most maxRoots bindings (oldest first out). A hash seen with two different
 * state roots is never served.
 * Deadlines and cancellation: a caller's `signal` ends only ITS wait (refresh() and walks are shared). A walk runs
 * under its own controller and the latest deadline of the callers waiting on it; it is aborted (no further header
 * fetch or helper check) when its last caller has gone or its deadline passes. `headers(hash, child, {signal,
 * deadline})` receives the walk's signal and deadline. Bindings already made by an aborted walk stay: they are
 * authenticated immutable history, not freshness. stop() pauses polling; close() is TERMINAL: polling stops, the
 * in-flight poll and every walk are aborted, a late poll answer is discarded, and rootFor/offer/refresh do no new work.
 */
export function createRootStore({ checker, consensusUrl, fetch = globalThis.fetch, timeoutMs = 5000, maxRoots = 8192, maxCommitmentBytes = 8 << 20,
  maxAncestry = 256 } = {}) {
  if (!checker?.check) throw new Error('checker required');
  if (!Number.isSafeInteger(maxAncestry) || maxAncestry < 1 || maxAncestry > 8191) throw new Error('invalid maxAncestry');
  const base = consensusUrl === undefined ? null : rpcEndpoint(consensusUrl).url.href.replace(/\/?$/, '/');
  const roots = new Map(), conflicted = new Set(), recovering = new Map();
  const stats = { verified: 0, refused: 0, conflicts: 0, polls: 0, pollFailures: 0, ancestors: 0, ancestryRefused: {} };
  let inflight = null, timer = null, closed = false;
  const life = new AbortController();
  const lower = (x) => String(x).toLowerCase();

  function bind(r, via, boundTo) {
    const hash = lower(r.blockHash), stateRoot = lower(r.stateRoot), parentHash = lower(r.parentHash);
    if (![hash, stateRoot, parentHash].every((x) => HASH.test(x)) || !Number.isSafeInteger(r.number) || !Number.isSafeInteger(r.timestamp)) return null;
    const had = roots.get(hash);
    if (had && had.stateRoot !== stateRoot) { conflicted.add(hash); stats.conflicts++; return null; }
    if (had) return had;
    const entry = Object.freeze({ blockHash: hash, stateRoot, parentHash, number: r.number, timestamp: r.timestamp, via, ...(boundTo ? { boundTo } : {}) });
    roots.set(hash, entry);
    if (via === 'ancestor') stats.ancestors++; else stats.verified++;
    if (roots.size > maxRoots) roots.delete(roots.keys().next().value);
    return entry;
  }
  /** Push a sequencer commitment (verified independently here; the pusher is not trusted). */
  async function offer(commitment, { signal } = {}) {
    if (closed) return null;
    const r = await checker.check({ op: 'head', commitment }, { signal: signal ? AbortSignal.any([signal, life.signal]) : life.signal });
    if (closed) return null;                               // a late answer after close() binds nothing
    if (!r.ok) { stats.refused++; return null; }
    return bind(r, 'signed-head');
  }
  async function poll() {
    if (!base) return null;
    stats.polls++;
    try {
      const res = await fetch(base + 'latest', { redirect: 'error', credentials: 'omit', signal: AbortSignal.any([life.signal, AbortSignal.timeout(timeoutMs)]) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const c = JSON.parse(await readBounded(res, maxCommitmentBytes));
      return c && !closed ? await offer(c) : null;     // null: no head to offer (e.g. stale), or the store closed
    } catch { stats.pollFailures++; return null; }
  }
  /** One coalesced poll of the head source. */
  function refresh() { return closed ? Promise.resolve(null) : (inflight ??= poll().finally(() => { inflight = null; })); }
  const refuse = (why) => { stats.ancestryRefused[why] = (stats.ancestryRefused[why] || 0) + 1; return null; };
  const child = (e) => ({ number: e.number, timestamp: e.timestamp, parentHash: e.parentHash });

  async function recover(h, headers, walk) {
    const ctx = () => ({ signal: walk.ac.signal, deadline: walk.deadline });
    if (!roots.size) return refuse('no-bound-head');       // nothing can anchor a walk: no source is asked
    const guide = await headers(h, null, ctx());           // self-consistent header for h: only its NUMBER is used
    if (walk.ac.signal.aborted) return refuse('deadline');
    if (!guide) return refuse('unavailable');
    const n = guide.head.number;
    let above = null;                                      // the nearest bound block above n
    for (const e of roots.values()) if (e.number > n && (!above || e.number < above.number)) above = e;
    if (!above) return refuse('newer-than-every-bound-head');
    if (above.number - n > maxAncestry) return refuse('too-deep');
    let cur = above;
    while (cur.number > n + 1) {
      if (walk.ac.signal.aborted || Date.now() > walk.deadline) return refuse('deadline');
      let parent = roots.get(cur.parentHash);
      if (!parent) {
        const got = await headers(cur.parentHash, child(cur), ctx());
        if (walk.ac.signal.aborted || closed) return refuse('deadline');
        if (!got) return refuse('unavailable');
        parent = bind(got.head, 'ancestor', cur.blockHash);
        if (!parent) return refuse('conflict');
      }
      if (parent.number + 1 !== cur.number) return refuse('mismatched-link');
      cur = parent;
    }
    if (cur.parentHash !== h) return refuse('not-an-ancestor');   // h is not on the bound chain (fork, orphan or a lie)
    const r = await checker.check({ op: 'header', header: guide.header, expectHash: h, child: child(cur) }, { signal: walk.ac.signal });
    if (closed) return null;
    if (!r.ok) return refuse('mismatched-link');
    return bind(r, 'ancestor', cur.blockHash) ?? refuse('conflict');
  }
  /** The binding for a block hash, or null (the caller must refuse). See above for `headers`, `deadline`, `signal`.
   *  Rejects with signal.reason when the caller's signal aborts first. */
  async function rootFor(blockHash, { headers = null, deadline = Date.now() + 30000, signal } = {}) {
    const h = lower(blockHash);
    if (closed || conflicted.has(h)) return null;
    if (signal?.aborted) throw signal.reason;
    if (!roots.has(h)) await abortable(refresh(), signal);   // shared poll: one caller's abort does not cancel it
    if (!roots.has(h) && headers && HASH.test(h) && !conflicted.has(h) && !closed) {
      let walk = recovering.get(h);
      if (!walk || walk.ac.signal.aborted) {               // never join a walk that was already abandoned
        walk = { ac: new AbortController(), subs: 0, deadline };
        const onLife = () => walk.ac.abort(life.signal.reason);
        life.signal.addEventListener('abort', onLife, { once: true });
        walk.timer = setTimeout(() => walk.ac.abort(new Error('ancestry walk deadline')), Math.max(0, deadline - Date.now()));
        walk.promise = recover(h, headers, walk).catch((e) => { if (walk.ac.signal.aborted) return refuse('deadline'); throw e; })
          .finally(() => { clearTimeout(walk.timer); life.signal.removeEventListener('abort', onLife); if (recovering.get(h) === walk) recovering.delete(h); });
        recovering.set(h, walk);
      }
      if (deadline > walk.deadline) {                       // a later caller extends the shared walk, never shortens it
        walk.deadline = deadline; clearTimeout(walk.timer);
        walk.timer = setTimeout(() => walk.ac.abort(new Error('ancestry walk deadline')), Math.max(0, deadline - Date.now()));
      }
      walk.subs++;
      try { await abortable(walk.promise, signal); } finally { if (--walk.subs === 0) walk.ac.abort(new Error('no caller is waiting for this walk')); }
    }
    return closed || conflicted.has(h) ? null : roots.get(h) || null;
  }
  function start(pollMs = 1000) { if (closed) return; stop(); timer = setInterval(() => { refresh(); }, pollMs); timer.unref?.(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function close() { closed = true; stop(); life.abort(new Error('root store closed')); }
  return { rootFor, offer, addCommitment: offer, refresh, start, stop, close,
    stats: () => ({ ...stats, ancestryRefused: { ...stats.ancestryRefused }, roots: roots.size, conflicted: conflicted.size, recovering: recovering.size, closed }) };
}
