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
 * checker: createWitnessChecker. consensusUrl: the consensus head API (https, or http on loopback). -> {rootFor(hash),
 * addCommitment(commitment), refresh(), start(pollMs), stop(), stats()}. Keeps at most maxRoots bindings (oldest by
 * insertion dropped). A block hash seen with two different state roots is never served (it cannot happen for a valid
 * hash; if it does, the store refuses rather than choose).
 */
export function createRootStore({ checker, consensusUrl, fetch = globalThis.fetch, timeoutMs = 5000, maxRoots = 8192, maxCommitmentBytes = 8 << 20 } = {}) {
  if (!checker?.check) throw new Error('checker required');
  const base = consensusUrl === undefined ? null : rpcEndpoint(consensusUrl).url.href.replace(/\/?$/, '/');
  const roots = new Map(), conflicted = new Set();
  const stats = { verified: 0, refused: 0, conflicts: 0, polls: 0, pollFailures: 0 };
  let inflight = null, timer = null;

  async function addCommitment(commitment) {
    const r = await checker.check({ op: 'head', commitment });
    if (!r.ok) { stats.refused++; return null; }
    const hash = String(r.blockHash).toLowerCase(), stateRoot = String(r.stateRoot).toLowerCase();
    if (!HASH.test(hash) || !HASH.test(stateRoot)) { stats.refused++; return null; }
    const had = roots.get(hash);
    if (had && had.stateRoot !== stateRoot) { conflicted.add(hash); stats.conflicts++; return null; }
    if (!had) {
      stats.verified++;
      roots.set(hash, { blockHash: hash, stateRoot, number: r.number, timestamp: r.timestamp });
      if (roots.size > maxRoots) roots.delete(roots.keys().next().value);
    }
    return roots.get(hash);
  }
  async function poll() {
    if (!base) return null;
    stats.polls++;
    try {
      const res = await fetch(base + 'latest', { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const c = JSON.parse(await readBounded(res, maxCommitmentBytes));
      return c ? await addCommitment(c) : null;     // null: the source has no head to offer (e.g. stale)
    } catch { stats.pollFailures++; return null; }
  }
  /** One coalesced poll of the head source. */
  function refresh() { return (inflight ??= poll().finally(() => { inflight = null; })); }
  async function rootFor(blockHash) {
    const h = String(blockHash).toLowerCase();
    if (conflicted.has(h)) return null;
    if (!roots.has(h)) await refresh();             // a head Helios just adopted may be newer than our last poll
    return conflicted.has(h) ? null : roots.get(h) || null;
  }
  function start(pollMs = 1000) { stop(); timer = setInterval(() => { refresh(); }, pollMs); timer.unref?.(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { rootFor, addCommitment, refresh, start, stop, stats: () => ({ ...stats, roots: roots.size, conflicted: conflicted.size }) };
}
