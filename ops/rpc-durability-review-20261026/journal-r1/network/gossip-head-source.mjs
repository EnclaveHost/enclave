// A local, native head source for op-head-relay.mjs: runs the pinned enclave-base-head-listener (Base mainnet unsafe-block
// gossip through base/base's maintained base-consensus-gossip, 5476069f) as an owned child process and turns each head it
// accepted into the Helios SequencerCommitment the relay already verifies and serves. No hosted consensus URL is involved.
//
// Trust: tier "unsafe", finality "none". A head proves only that the pinned sequencer key signed that block. Nothing here
// derives L1 safety or finality, and nothing here fetches state or falls back to any public endpoint.
//
// Per head, every check must pass or the head is dropped (fail closed):
//   1. the session's start record names the pinned chain, signer (admin pin), schema and base/base source commit;
//   2. the head record is well-formed, labelled unsafe/none, for the pinned chain and signer, received in THIS session;
//   3. the object file is the session's own, its size and sha256 match the record and stay under the cap;
//   4. the pinned listener binary's `commitment` mode accepts it: maintained base/base decode + signer + chain domain +
//      block-hash verification FIRST, then (maintained `snap` decoder, bounded before allocation) the exact original
//      decompressed bytes after the 65-byte signature, bound to the verified payload hash; its metadata (including the
//      sha256 of the bytes it read) must equal the record;
//   5. op-head-relay's verifyCommitment independently recovers the pinned signer over those exact bytes for the pinned
//      chain, and the decoded number/hash/stateRoot/parentHash/timestamp equal the record;
//   6. the block timestamp is within maxHeadAgeMs of now (and not more than 5 s ahead).
// No decoding of the object happens in JavaScript.
//
// Restarts (exact behaviour): this source judges freshness only from the signed block timestamp. A new session starts
// with an empty object directory and refuses records stamped before it started, so nothing from an earlier session is
// re-read or re-delivered. `status().head` stays the last delivered head but reports fresh only while that head's own
// timestamp is within maxHeadAgeMs AND it was delivered less than staleAfterMs ago. The relay keeps its highest verified
// head across source restarts and serves it only while ITS signed timestamp is within the relay's maxAgeMs (and not
// equivocated); a restart therefore never extends any head's freshness, but a head delivered just before a restart can
// still be served until it ages out (at most maxAgeMs after its block timestamp).
//
// Disk: each session directory holds only what the listener wrote in it, capped by the listener's own --max-output-bytes
// budget (objects + records). Objects are deleted once processed or dropped; files whose record never arrives stay until
// the session ends, when the whole directory is removed. Session directories left by a crashed earlier run of this
// source (marked OWNER) are removed at start. Upper bound: one session's maxOutputBytes plus a few KiB.
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { verifyCommitment } from './op-head-relay.mjs';

export const SCHEMA = 'enclave-base-gossip-commitment/v1';
export const LISTENER_SCHEMA = 'enclave-base-unsafe-head/v1';
export const LISTENER_OBJECT_ENCODING = 'base-network-payload-envelope-v4-snappy';
export const BASE_SOURCE_COMMIT = '5476069f1eb74a56bccb56fdefd4b4bb0e3cda42';
export const NATIVE_COMMITMENT_SCHEMA = 'enclave-base-signed-commitment/v1';
/** The listener build this adapter was tested against: rpc-gossip-bridge/listener branch commitment-mode (f3159ea plus
 *  the `commitment` mode). The live-run listener f3159ea had 8ef3d51d...; its `listen` path is unchanged. */
export const TESTED_LISTENER_SHA256 = 'ebd045b428227530fac1c1b079f47c67ecb874637a1c7dcb4f021dd5929e8d3a';

const ADDR = /^0x[0-9a-f]{40}$/, H32 = /^0x[0-9a-f]{64}$/, SHA = /^[0-9a-f]{64}$/;
const RELAY_MAX_DATA = 4 * 1024 * 1024;   // op-head-relay.mjs MAX_DATA: larger commitments are refused there anyway
const LIMITS = Object.freeze({
  maxLineBytes: 16 * 1024,          // listener records are < 1 KiB
  stderrTailBytes: 16 * 1024,
  maxObjectBytes: 10 * (1 << 20),   // base MAX_GOSSIP_SIZE; the native mode refuses larger files unread
  maxQueuedHeads: 32,
  maxArchiveQueue: 16,
  maxArchiveQueuedBytes: 32 * (1 << 20),
  maxArchiveOutstanding: 2,         // timed-out archive calls still holding their entry
  nativeTimeoutMs: 10_000,
  nativeOutputSlack: 64 * 1024,     // native stdout <= 2 x maxDataBytes (hex) + this
  killGraceMs: 5_000,
});
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 60_000];

const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** /proc/<pid>/stat start time (clock ticks since boot) and process group, or null if the process is gone. */
export function procIdentity(pid) {
  let text;
  try { text = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');   // fields after "(comm)": state=3 ... pgrp=5 ... starttime=22
  if (rest[0] === 'Z' || rest[0] === 'X') return null;              // exited (zombie/dead): not signalable, not alive
  return { pgid: Number(rest[2]), startTime: rest[19] };
}

/** Every live process in `pgid` that started no earlier than the owned leader (i.e. could only have been created by it). */
async function ownedGroupMembers(owned) {
  const out = [];
  for (const name of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(name)) continue;
    const id = procIdentity(Number(name));
    if (id && id.pgid === owned.pgid && BigInt(id.startTime) >= BigInt(owned.startTime)) out.push({ pid: Number(name), ...id });
  }
  return out;
}

/** Signal only processes that are provably ours: the leader if its start time still matches, else surviving members of
 *  its process group created after it. Never signals a recycled PID. Returns the PIDs signalled. */
export async function signalOwned(owned, sig) {
  const leader = procIdentity(owned.pid);
  if (leader && leader.startTime === owned.startTime && leader.pgid === owned.pgid) {
    try { process.kill(-owned.pgid, sig); return [owned.pid]; } catch { return []; }
  }
  const hit = [];
  for (const m of await ownedGroupMembers(owned)) { try { process.kill(m.pid, sig); hit.push(m.pid); } catch {} }
  return hit;
}

function validateOptions(o) {
  const need = (ok, msg) => { if (!ok) throw new Error(msg); };
  need(typeof o.listenerPath === 'string' && path.isAbsolute(o.listenerPath), 'listenerPath must be an absolute path');
  need(SHA.test(o.listenerSha256 || ''), 'listenerSha256 (pinned binary digest) required');
  need(Number.isSafeInteger(o.chainId) && o.chainId > 0, 'chainId required');
  need(ADDR.test(lower(o.signer) || '') && !/^0x0{40}$/.test(o.signer), 'pinned unsafe signer required');
  need(typeof o.workDir === 'string' && path.isAbsolute(o.workDir), 'workDir must be an absolute path');
  need(typeof o.onCommitment === 'function', 'onCommitment callback required');
  for (const [k, lo, hi] of [['sessionSecs', 1, 3600], ['maxPeers', 1, 50], ['maxOutputBytes', 1 << 20, 1 << 30],
    ['maxHeadAgeMs', 1000, 600_000], ['staleAfterMs', 1000, 600_000], ['restartIfNoHeadMs', 5000, 3_600_000], ['discoveryAfterSecs', 0, 3600],
    ['maxDataBytes', 1024, RELAY_MAX_DATA], ['archiveTimeoutMs', 10, 600_000]])
    need(Number.isSafeInteger(o[k]) && o[k] >= lo && o[k] <= hi, `invalid ${k}`);
  need(['off', 'bounded'].includes(o.discovery), 'discovery must be off or bounded');
}

/**
 * createGossipHeadSource(options) -> { start(), stop(), status() }
 *   listenerPath, listenerSha256  absolute path of the pinned enclave-base-head-listener and its required sha256
 *   chainId, signer               pinned chain and administrator-pinned unsafe block signer
 *   workDir                       directory owned by this source (session object dirs live under it)
 *   onCommitment(commitment, meta) receives each verified commitment; use (c) => relay.offer(c, 'native-gossip')
 *   onArchive?(entry)             optional downstream sink (e.g. Sia). Fire-and-forget, bounded, never gates serving.
 *   sessionSecs (3600), maxPeers (20), maxOutputBytes (64 MiB), discovery ('bounded'), discoveryAfterSecs (10),
 *   maxHeadAgeMs (60000), staleAfterMs (30000), restartIfNoHeadMs (120000), maxDataBytes (4 MiB = relay MAX_DATA),
 *   archiveTimeoutMs (60000), now (Date.now), signal (AbortSignal)
 */
export function createGossipHeadSource(options) {
  const o = { sessionSecs: 3600, maxPeers: 20, maxOutputBytes: 64 << 20, discovery: 'bounded', discoveryAfterSecs: 10,
    maxHeadAgeMs: 60_000, staleAfterMs: 30_000, restartIfNoHeadMs: 120_000, maxDataBytes: RELAY_MAX_DATA,
    archiveTimeoutMs: 60_000, now: Date.now, extraEnv: {}, ...options };
  validateOptions(o);
  const signer = lower(o.signer);
  const counters = { sessions: 0, restarts: 0, heads: 0, delivered: 0, rejected: {}, queueDropped: 0, archiveDropped: 0,
    archiveFailed: 0, archiveTimedOut: 0, archiveSkipped: 0, archived: 0, staleSessionDirsRemoved: 0 };
  const reject = (reason) => { counters.rejected[reason] = (counters.rejected[reason] || 0) + 1; };
  let session = null, stopped = true, restartTimer = null, watchdog = null, backoff = 0, lastHead = null, lastExit = null;
  let processing = Promise.resolve();
  const archiveQueue = []; let archiving = false, archiveQueuedBytes = 0, archiveOutstanding = 0;

  function fresh(ts) {
    const ms = Number(ts) * 1000, now = o.now();
    return ms + o.maxHeadAgeMs > now && ms <= now + 5000;
  }

  async function verifyBinary() {
    const digest = sha256(await readFile(o.listenerPath));
    if (digest !== o.listenerSha256) throw new Error(`listener binary digest ${digest} does not match the pin`);
  }

  /** Runs the pinned binary's `commitment` mode on one object; stdout is bounded by maxBuffer (hex expansion included). */
  function runNativeCommitment(file) {
    return new Promise((resolve) => {
      execFile(o.listenerPath, ['commitment', '--signer', signer, '--file', file, '--max-data-bytes', String(o.maxDataBytes)],
        { timeout: LIMITS.nativeTimeoutMs, maxBuffer: 2 * o.maxDataBytes + LIMITS.nativeOutputSlack, killSignal: 'SIGKILL',
          env: { PATH: '/usr/bin:/bin', ...o.extraEnv } },
        (err, stdout) => {
          if (err) return resolve({ ok: false, why: err.killed ? 'native-timeout' : err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'native-output-too-large' : 'native-refused' });
          try { const v = JSON.parse(stdout); resolve(v && v.ok === true ? { ok: true, v } : { ok: false, why: 'native-refused' }); }
          catch { resolve({ ok: false, why: 'native-output' }); }
        });
    });
  }

  /** Reads at most `max` bytes of `file` (used only for the optional archive copy). */
  async function readBounded(file, max) {
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(max + 1);
      const { bytesRead } = await fh.read(buf, 0, max + 1, 0);
      if (bytesRead > max) throw new Error('object grew past its recorded size');
      return buf.subarray(0, bytesRead);
    } finally { await fh.close(); }
  }

  function validStart(r) {
    return r.schema === LISTENER_SCHEMA && r.type === 'start' && r.chainId === o.chainId && lower(r.signer) === signer
      && r.signerSource === 'admin-pin' && r.baseSourceCommit === BASE_SOURCE_COMMIT && r.objectEncoding === LISTENER_OBJECT_ENCODING;
  }

  function headShapeError(r, s) {
    if (r.schema !== LISTENER_SCHEMA || r.type !== 'head') return 'schema';
    if (r.tier !== 'unsafe' || r.finality !== 'none') return 'tier';
    if (r.chainId !== o.chainId) return 'chain';
    if (lower(r.signer) !== signer) return 'signer';
    if (r.payloadVersion !== 'v4' || r.objectEncoding !== LISTENER_OBJECT_ENCODING) return 'version';
    if (!SHA.test(r.objectSha256 || '') || !Number.isSafeInteger(r.objectBytes) || r.objectBytes <= 0) return 'shape';
    if (r.objectBytes > LIMITS.maxObjectBytes) return 'object-too-large';
    if (!Number.isSafeInteger(r.number) || !Number.isSafeInteger(r.timestamp) || ![r.hash, r.stateRoot, r.parentHash].every((h) => H32.test(lower(h) || ''))) return 'shape';
    if (!(Number(r.receivedUnixMs) >= s.startedAt)) return 'not-this-session';
    return null;
  }

  async function processHead(s, r) {
    const shape = headShapeError(r, s);
    if (shape) return reject(shape);
    if (!fresh(r.timestamp)) return reject('stale');
    const file = path.join(s.objects, `${r.objectSha256}.v4.snappy`);
    try {
      const st = await stat(file);
      if (!st.isFile() || st.size !== r.objectBytes) return reject('object-size');
    } catch { return reject('object-missing'); }
    const native = await runNativeCommitment(file);
    if (!native.ok) return reject(native.why);
    const nv = native.v;
    if (nv.schema !== NATIVE_COMMITMENT_SCHEMA || nv.type !== 'commitment' || nv.tier !== 'unsafe' || nv.finality !== 'none'
      || nv.chainId !== o.chainId || lower(nv.signer) !== signer || nv.payloadVersion !== 'v4' || nv.objectSha256 !== r.objectSha256
      || nv.number !== r.number || lower(nv.hash) !== lower(r.hash) || lower(nv.stateRoot) !== lower(r.stateRoot)
      || lower(nv.parentHash) !== lower(r.parentHash) || nv.timestamp !== r.timestamp) return reject('native-mismatch');
    const commitment = nv.commitment;
    if (!commitment || typeof commitment.data !== 'string' || commitment.data.length > 2 + 2 * o.maxDataBytes) return reject('native-mismatch');
    let checked;
    try { checked = await verifyCommitment(commitment, { chainId: o.chainId, signer }); } catch { return reject('commitment-signature'); }
    const h = checked.head;
    if (h.number !== BigInt(r.number) || lower(h.hash) !== lower(r.hash) || lower(h.stateRoot) !== lower(r.stateRoot)
      || lower(h.parentHash) !== lower(r.parentHash) || h.timestamp !== BigInt(r.timestamp)) return reject('commitment-mismatch');
    if (!fresh(r.timestamp)) return reject('stale');   // re-check after the native verification round trip
    const meta = { schema: SCHEMA, tier: 'unsafe', finality: 'none', source: 'native-gossip', chainId: o.chainId, signer,
      number: r.number, hash: lower(r.hash), stateRoot: lower(r.stateRoot), timestamp: r.timestamp, objectSha256: r.objectSha256, session: s.n };
    try { await o.onCommitment(checked.commitment, meta); } catch { return reject('consumer-error'); }
    counters.delivered++;
    lastHead = { ...meta, deliveredAt: o.now() };
    backoff = 0;
    if (o.onArchive) {
      // archive copy: the object bytes, re-read bounded and checked against the digest the native mode verified
      let bytes = null;
      try { bytes = await readBounded(file, r.objectBytes); } catch {}
      if (bytes && sha256(bytes) === r.objectSha256) enqueueArchive({ meta, object: bytes, commitment: checked.commitment });
      else counters.archiveSkipped++;
    }
  }

  /** Bounded, serial, fire-and-forget archive queue: at most maxArchiveQueue entries and maxArchiveQueuedBytes queued,
   *  each call abandoned after archiveTimeoutMs, and at most maxArchiveOutstanding abandoned calls still pending before
   *  new entries are dropped. Never awaited by the serving path. */
  function enqueueArchive(entry) {
    const size = entry.object.length + entry.commitment.data.length;
    while (archiveQueue.length && (archiveQueue.length >= LIMITS.maxArchiveQueue || archiveQueuedBytes + size > LIMITS.maxArchiveQueuedBytes)) {
      archiveQueuedBytes -= archiveQueue.shift().size; counters.archiveDropped++;
    }
    if (size > LIMITS.maxArchiveQueuedBytes) { counters.archiveDropped++; return; }
    archiveQueue.push({ entry, size }); archiveQueuedBytes += size;
    if (archiving) return;
    archiving = true;
    (async () => {
      while (archiveQueue.length) {
        if (archiveOutstanding >= LIMITS.maxArchiveOutstanding) {   // hung sink: drop instead of piling up calls
          while (archiveQueue.length) { archiveQueuedBytes -= archiveQueue.shift().size; counters.archiveDropped++; }
          break;
        }
        const { entry: next, size: n } = archiveQueue.shift(); archiveQueuedBytes -= n;
        archiveOutstanding++;
        let settled = false;
        const call = Promise.resolve().then(() => o.onArchive(next))
          .then(() => { counters.archived++; }, () => { counters.archiveFailed++; })
          .finally(() => { settled = true; archiveOutstanding--; });
        let timer;
        await Promise.race([call, new Promise((r) => { timer = setTimeout(r, o.archiveTimeoutMs); timer.unref?.(); })]);
        clearTimeout(timer);
        if (!settled) counters.archiveTimedOut++;
      }
      archiving = false;
    })();
  }

  /** Deletes the object a dropped record names (only a well-formed sha256 name inside this session's object dir). */
  function discard(s, r) {
    if (SHA.test(r?.objectSha256 || '')) rm(path.join(s.objects, `${r.objectSha256}.v4.snappy`), { force: true }).catch(() => {});
  }

  function onLine(s, line) {
    let r;
    try { r = JSON.parse(line); } catch { return reject('record-json'); }
    if (!r || typeof r !== 'object') return reject('record-json');
    if (r.type === 'start') {
      if (s.started || !validStart(r)) { reject('start-mismatch'); return endSession(s, 'start-mismatch'); }
      s.started = true;
      return;
    }
    if (r.type !== 'head') return;   // discovery-started / progress / summary are diagnostics only
    if (!s.started) { discard(s, r); return reject('head-before-start'); }
    counters.heads++;
    if (s.queued >= LIMITS.maxQueuedHeads) { discard(s, r); counters.queueDropped++; return; }
    s.queued++;
    // Heads already read from this session finish processing before its directory is removed (endSession awaits this
    // chain), so stop() resolves only after the last delivery; nothing is delivered after stop() returns.
    // Each object file is deleted as soon as it was processed (accepted or not); the archive hook got its own copy.
    const done = () => { s.queued--; discard(s, r); };
    processing = processing.then(() => processHead(s, r)).finally(done);
  }

  function attachStdout(s) {
    let buf = '';
    s.child.stdout.setEncoding('utf8');
    s.child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.length > LIMITS.maxLineBytes) { reject('line-too-long'); return endSession(s, 'line-too-long'); }
        if (line) onLine(s, line);
      }
      if (buf.length > LIMITS.maxLineBytes) { buf = ''; reject('line-too-long'); endSession(s, 'line-too-long'); }
    });
    s.child.stderr.on('data', (chunk) => { s.stderrTail = (s.stderrTail + chunk).slice(-LIMITS.stderrTailBytes); });
  }

  async function startSession() {
    if (stopped) return;
    await verifyBinary();
    const n = ++counters.sessions;
    const dir = path.join(o.workDir, 'sessions', `s${n}-${randomBytes(6).toString('hex')}`);
    await mkdir(path.join(dir, 'home'), { recursive: true });
    await writeFile(path.join(dir, 'OWNER'), `gossip-head-source pid=${process.pid}\n`, { flag: 'wx' });
    const s = { n, dir, objects: path.join(dir, 'out', 'objects'), startedAt: o.now(), started: false, ended: false,
      queued: 0, stderrTail: '', child: null, owned: null, exit: null };
    const args = ['listen', '--signer', signer, '--duration-secs', String(o.sessionSecs), '--max-peers', String(o.maxPeers),
      '--max-output-bytes', String(o.maxOutputBytes), '--out-dir', path.join(dir, 'out'), '--listen', '127.0.0.1:0',
      '--discovery', o.discovery, '--discovery-after-secs', String(o.discoveryAfterSecs)];
    s.child = spawn(o.listenerPath, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: path.join(dir, 'home'), RUST_LOG: 'warn', ...o.extraEnv } });
    const id = s.child.pid ? procIdentity(s.child.pid) : null;
    s.owned = id && id.pgid === s.child.pid ? { pid: s.child.pid, pgid: id.pgid, startTime: id.startTime } : null;
    // 'close' fires after the child exited AND its stdio drained, so no buffered head line is lost at exit.
    s.exited = new Promise((resolve) => {
      s.child.once('close', (code, sig) => { s.exit ||= { code, signal: sig, at: o.now() }; resolve(); });
      s.child.once('error', () => { s.exit ||= { code: null, signal: null, error: 'spawn', at: o.now() }; resolve(); });
    });
    attachStdout(s);
    s.exited.then(() => endSession(s, s.exit?.error ? 'spawn-error' : 'listener-exit'));
    session = s;
    if (!s.owned) endSession(s, 'identity-unavailable');
  }

  async function endSession(s, reason) {
    if (s.ended) return;
    s.ended = true; s.reason = reason;
    if (s.owned && !s.exit) {
      await signalOwned(s.owned, 'SIGTERM');
      const done = await Promise.race([s.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), LIMITS.killGraceMs).unref?.())]);
      if (!done) await signalOwned(s.owned, 'SIGKILL');
    }
    await s.exited?.catch(() => {});
    if (s.owned) for (const m of await ownedGroupMembers(s.owned)) { try { process.kill(m.pid, 'SIGKILL'); } catch {} }
    await processing.catch(() => {});
    lastExit = { session: s.n, reason, exit: s.exit, stderrTail: s.stderrTail.slice(-2048) };
    await rm(s.dir, { recursive: true, force: true }).catch(() => {});
    if (session === s) session = null;
    scheduleRestart();
  }

  function scheduleRestart() {
    if (stopped || restartTimer) return;
    const delay = BACKOFF_MS[Math.min(backoff, BACKOFF_MS.length - 1)];
    backoff++;
    counters.restarts++;
    restartTimer = setTimeout(() => { restartTimer = null; startSession().catch((e) => { lastExit = { error: String(e.message || e) }; scheduleRestart(); }); }, delay);
    restartTimer.unref?.();
  }

  function tickWatchdog() {
    const s = session;
    if (!s || s.ended) return;
    const since = Math.max(s.startedAt, lastHead?.deliveredAt ?? 0);
    if (o.now() - since >= o.restartIfNoHeadMs) endSession(s, 'no-head-timeout');
  }

  async function start() {
    if (!stopped) return;
    stopped = false;
    await mkdir(path.join(o.workDir, 'sessions'), { recursive: true });
    // Remove session directories a crashed earlier run of this source left behind (only ones carrying our OWNER marker).
    for (const name of await readdir(path.join(o.workDir, 'sessions')).catch(() => [])) {
      const dir = path.join(o.workDir, 'sessions', name);
      const owner = await readFile(path.join(dir, 'OWNER'), 'utf8').catch(() => '');
      if (/^s\d+-[0-9a-f]{12}$/.test(name) && owner.startsWith('gossip-head-source ')) {
        await rm(dir, { recursive: true, force: true }); counters.staleSessionDirsRemoved++;
      }
    }
    o.signal?.addEventListener('abort', () => { stop(); }, { once: true });
    watchdog = setInterval(tickWatchdog, 1000); watchdog.unref?.();
    try { await startSession(); } catch (e) { lastExit = { error: String(e.message || e) }; await stop(); throw e; }
  }

  async function stop() {
    stopped = true;
    clearTimeout(restartTimer); restartTimer = null;
    clearInterval(watchdog); watchdog = null;
    if (session) await endSession(session, 'stopped');
    await processing.catch(() => {});
  }

  function status() {
    const head = lastHead && fresh(lastHead.timestamp) ? lastHead : null;
    const deliveredAgo = lastHead ? o.now() - lastHead.deliveredAt : null;
    return {
      schema: SCHEMA, trust: 'op-sequencer-signed-unsafe-head', tier: 'unsafe', finality: 'none', source: 'native-gossip',
      chainId: o.chainId, signer, fresh: !!head && deliveredAgo < o.staleAfterMs, head,
      running: !!session && !session.ended,
      session: session ? { n: session.n, pid: session.owned?.pid ?? null, startedAt: session.startedAt, started: session.started } : null,
      lastExit, counters: { ...counters, rejected: { ...counters.rejected } },
    };
  }

  return { start, stop, status };
}
