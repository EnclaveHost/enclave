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

/**
 * bin: the witness-check executable; chainId, signer: the pinned chain and unsafe-block signer (the same pins Helios is
 * given). -> {check(request) -> {ok, ...}, close()}. A check that cannot complete (helper missing, crashed, over
 * timeoutMs, queue full) REJECTS: the caller must refuse, never treat it as a pass. The helper is restarted on next use.
 */
export function createWitnessChecker({ bin, chainId, signer, timeoutMs = 10000, maxPending = 256, maxRequestBytes = 48 << 20 } = {}) {
  if (typeof bin !== 'string' || !bin) throw new Error('witness-check binary path required');
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('chainId required');
  if (!/^0x[0-9a-fA-F]{40}$/.test(signer || '')) throw new Error('signer address required');
  let child = null, buffer = '', seq = 0;
  const pending = new Map();
  const failAll = (why) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); } pending.clear(); };
  function start() {
    const c = spawn(bin, ['--chain-id', String(chainId), '--signer', signer], { stdio: ['pipe', 'pipe', 'ignore'] });
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d) => {
      buffer += d;
      if (buffer.length > 1 << 20) { failAll('witness verifier output too long'); c.kill('SIGKILL'); return; }
      for (let i; (i = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        let reply; try { reply = JSON.parse(line); } catch { continue; }
        const p = pending.get(reply.id);
        if (!p) continue;
        pending.delete(reply.id); clearTimeout(p.timer); p.resolve(reply);
      }
    });
    c.stdin.on('error', () => {});
    c.on('error', () => {});
    c.on('exit', () => { if (child === c) { child = null; buffer = ''; failAll('witness verifier exited'); } });
    return c;
  }
  async function check(request) {
    if (pending.size >= maxPending) throw new Error('witness verifier queue full');
    const id = ++seq;
    const line = JSON.stringify({ ...request, id }) + '\n';
    if (Buffer.byteLength(line) > maxRequestBytes) throw new Error('witness check request too large');
    child ??= start();
    const c = child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // a hung verifier is killed: every pending check fails (callers refuse) and the next check restarts it
        if (child === c) { child = null; buffer = ''; }
        failAll('witness verifier timed out'); c.kill('SIGKILL');
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      c.stdin.write(line);
    });
  }
  function close() { const c = child; child = null; failAll('witness verifier closed'); c?.kill('SIGKILL'); }
  return { check, close };
}

/**
 * checker: createWitnessChecker. consensusUrl: the consensus head API (https, or http on loopback); optional when heads
 * are pushed with offer(). -> {rootFor(hash, {headers, deadline}), offer(commitment), addCommitment (= offer),
 * refresh(), start(pollMs), stop(), stats()}.
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
 */
export function createRootStore({ checker, consensusUrl, fetch = globalThis.fetch, timeoutMs = 5000, maxRoots = 8192, maxCommitmentBytes = 8 << 20,
  maxAncestry = 256 } = {}) {
  if (!checker?.check) throw new Error('checker required');
  if (!Number.isSafeInteger(maxAncestry) || maxAncestry < 1 || maxAncestry > 8191) throw new Error('invalid maxAncestry');
  const base = consensusUrl === undefined ? null : rpcEndpoint(consensusUrl).url.href.replace(/\/?$/, '/');
  const roots = new Map(), conflicted = new Set(), recovering = new Map();
  const stats = { verified: 0, refused: 0, conflicts: 0, polls: 0, pollFailures: 0, ancestors: 0, ancestryRefused: {} };
  let inflight = null, timer = null;
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
  async function offer(commitment) {
    const r = await checker.check({ op: 'head', commitment });
    if (!r.ok) { stats.refused++; return null; }
    return bind(r, 'signed-head');
  }
  async function poll() {
    if (!base) return null;
    stats.polls++;
    try {
      const res = await fetch(base + 'latest', { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const c = JSON.parse(await readBounded(res, maxCommitmentBytes));
      return c ? await offer(c) : null;     // null: the source has no head to offer (e.g. stale)
    } catch { stats.pollFailures++; return null; }
  }
  /** One coalesced poll of the head source. */
  function refresh() { return (inflight ??= poll().finally(() => { inflight = null; })); }
  const refuse = (why) => { stats.ancestryRefused[why] = (stats.ancestryRefused[why] || 0) + 1; return null; };
  const child = (e) => ({ number: e.number, timestamp: e.timestamp, parentHash: e.parentHash });

  async function recover(h, headers, deadline) {
    if (!roots.size) return refuse('no-bound-head');       // nothing can anchor a walk: no source is asked
    const guide = await headers(h, null, deadline);        // self-consistent header for h: only its NUMBER is used
    if (!guide) return refuse('unavailable');
    const n = guide.head.number;
    let above = null;                                      // the nearest bound block above n
    for (const e of roots.values()) if (e.number > n && (!above || e.number < above.number)) above = e;
    if (!above) return refuse('newer-than-every-bound-head');
    if (above.number - n > maxAncestry) return refuse('too-deep');
    let cur = above;
    while (cur.number > n + 1) {
      if (Date.now() > deadline) return refuse('deadline');
      let parent = roots.get(cur.parentHash);
      if (!parent) {
        const got = await headers(cur.parentHash, child(cur), deadline);
        if (!got) return refuse('unavailable');
        parent = bind(got.head, 'ancestor', cur.blockHash);
        if (!parent) return refuse('conflict');
      }
      if (parent.number + 1 !== cur.number) return refuse('mismatched-link');
      cur = parent;
    }
    if (cur.parentHash !== h) return refuse('not-an-ancestor');   // h is not on the bound chain (fork, orphan or a lie)
    const r = await checker.check({ op: 'header', header: guide.header, expectHash: h, child: child(cur) });
    if (!r.ok) return refuse('mismatched-link');
    return bind(r, 'ancestor', cur.blockHash) ?? refuse('conflict');
  }
  /** The binding for a block hash, or null (the caller must refuse). See above for `headers` and `deadline`. */
  async function rootFor(blockHash, { headers = null, deadline = Date.now() + 30000 } = {}) {
    const h = lower(blockHash);
    if (conflicted.has(h)) return null;
    if (!roots.has(h)) await refresh();             // a head Helios just adopted may be newer than our last poll
    if (!roots.has(h) && headers && HASH.test(h) && !conflicted.has(h)) {
      let p = recovering.get(h);
      if (!p) { p = recover(h, headers, deadline).finally(() => recovering.delete(h)); recovering.set(h, p); }
      await p;
    }
    return conflicted.has(h) ? null : roots.get(h) || null;
  }
  function start(pollMs = 1000) { stop(); timer = setInterval(() => { refresh(); }, pollMs); timer.unref?.(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { rootFor, offer, addCommitment: offer, refresh, start, stop,
    stats: () => ({ ...stats, ancestryRefused: { ...stats.ancestryRefused }, roots: roots.size, conflicted: conflicted.size, recovering: recovering.size }) };
}
