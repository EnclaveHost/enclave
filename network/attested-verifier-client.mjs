// network/attested-verifier-client.mjs - a REMOTE chain verifier whose answers a caller may use because SEV-SNP hardware
// attests what produced them: the measured direct-control image (metal/guest/measured-control.mjs), running a
// chainVerifier member with expose "attested" inside a config the caller pinned, bound by HOST_DATA.
//
// What it is and is not (labels the readers carry, network/attested-verifier-brand.mjs):
//   * attested EXECUTION: the verifier (patched Helios over proofs against the sequencer-signed head) runs in the attested
//     guest. THIS process checks no proof; it checks the attestation. Never called "local" proof verification;
//   * tier: the sequencer-signed UNSAFE head; finality: none (no L1 derivation);
//   * replicas: ordered FAILOVER for availability. Answers are never compared, combined or counted: there is no quorum.
//
// Attestation, per replica (metal/measured-control-verify.mjs verifyMeasuredControl, UNCHANGED, called with no registry
// reader): one TLS connection returns the evidence for OUR fresh 32-byte nonce and its peer SPKI; the statement is canonical;
// its config digest is the caller's pinned config and HOST_DATA derives from it; the peer SPKI is the attested control key;
// the SNP report passes verifier/snp.mjs (AMD chain, CRL, TCB floor, allowed measurement, report_data = statement + nonce,
// CONTROL_ROLE, HOST_DATA); the supervisor behind it holds the minted keys. The registry step is NOT run (it reads a chain:
// circular for a caller that needs this verifier to read the chain), so the accepted outcome is EXACTLY verifyMeasuredControl's
// "pending" with every other check true and checks.registry === null - reported here as "attested", never as "verified".
//
// Deadlines: request(method, params, ms, signal) has ONE deadline (ms) for everything it does - waiting for or running an
// attestation and asking each replica in turn - and settles as soon as the deadline passes or the caller aborts, even while a
// shared attestation is still running. An attestation is bounded by its own budget (the starting request's remaining time,
// at most timeoutMs, per verifyMeasuredControl step) and runs at most once per replica at a time, whoever waits on it.
// Requests: JSON-RPC over a NEW TLS connection per request whose peer SPKI must equal the attested key BEFORE any byte is
// sent (tls.connect, check on secureConnect, then HTTP over that socket); the socket is destroyed on abort, deadline or
// close(). No public endpoint, no other server, no fallback.
import tls from 'node:tls';
import http from 'node:http';
import { createHash, X509Certificate } from 'node:crypto';
// the IMAGE lineage's exact guest verification (statement, config digest, HOST_DATA, SNP via verifier/snp.mjs), as the pinned
// generated bundle built from that lineage (scripts/build-attested-guest-verify.mjs; its manifest names the source commit)
import { verifyMeasuredControl, canonicalDirectConfig, configDigest, CHAIN_VERIFIER_ROUTE, CHAIN_VERIFIER_READ_METHODS, MAX_VERIFIER_ANSWER_BYTES } from './attested-guest-verify.bundle.mjs';
import { TCB_FIELDS } from '../relay/snp-verify.mjs';
import { markAttestedVerifierClient } from './attested-verifier-brand.mjs';

const READ = new Set(CHAIN_VERIFIER_READ_METHODS);
const HEX96 = /^[0-9a-f]{96}$/, ADDR = /^0x[0-9a-f]{40}$/;
export const MAX_REPLICAS = 8;
const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');
const bad = (m) => { throw new Error(`attested verifier: ${m}`); };
const aborted = (why) => Object.assign(new Error(`attested verifier: ${why}`), { code: 'ABORT_ERR' });

/** The minimum-TCB floor, with exactly the rules verifier/snp.mjs applies (relay/snp-verify.mjs checkMinTcb): an object keyed
 *  by a SUPPORTED product line, each naming exactly that line's TCB fields as integers 0-255. Checked at configuration, so a
 *  malformed floor is refused before any replica is contacted (the verifier would also refuse it, per attestation). */
export function checkMinTcbFloor(minTcb, what = 'minTcb') {
  if (!minTcb || typeof minTcb !== 'object' || Array.isArray(minTcb)) bad(`${what}: an explicit TCB floor object keyed by product line is required`);
  const lines = Object.keys(minTcb);
  if (!lines.length) bad(`${what}: names no product line`);
  for (const line of lines) {
    if (!Object.hasOwn(TCB_FIELDS, line)) bad(`${what}: unsupported product line "${line}" (supported: ${Object.keys(TCB_FIELDS).join(', ')})`);
    const f = minTcb[line], fields = TCB_FIELDS[line];
    if (!f || typeof f !== 'object' || Array.isArray(f)) bad(`${what}.${line} must be an object`);
    for (const k of Object.keys(f)) if (!fields.includes(k)) bad(`${what}.${line} has unknown field "${k}"`);
    for (const k of fields) if (!Number.isInteger(f[k]) || f[k] < 0 || f[k] > 255) bad(`${what}.${line}.${k} must be an integer 0-255`);
  }
  return Object.freeze(Object.fromEntries(lines.map((l) => [l, Object.freeze({ ...minTcb[l] })])));
}

/**
 * replicas: [{ url: "https://<host>:<port>" (origin only), config: the replica's FULL direct config (raw or canonical; its
 *   digest is pinned), measurements: [96-hex launch digests of the reviewed image], minTcb: TCB floor, crl?, product?,
 *   guestPolicy?, roots? }], unsafeSigner: the caller's pinned sequencer key.
 * roots (a non-AMD ARK pin: the synthetic test chain) is refused unless the CALLER passes allowTestRoots: true in code; no
 * configuration file can set it (network/wg-provider/attested-authority.mjs never does), so production trust is AMD's pin.
 */
export function checkAttestedReplicas(replicas, { unsafeSigner, allowTestRoots = false } = {}) {
  const signer = String(unsafeSigner || '').toLowerCase();
  if (!ADDR.test(signer) || /^0x0{40}$/.test(signer)) bad('unsafeSigner: the caller\'s pinned sequencer address is required');
  if (!Array.isArray(replicas) || replicas.length < 1 || replicas.length > MAX_REPLICAS) bad(`replicas: 1 to ${MAX_REPLICAS}`);
  const seen = new Set();
  return Object.freeze(replicas.map((r, i) => {
    const w = `replicas[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) bad(`${w} must be an object`);
    for (const k of Object.keys(r)) if (!['url', 'config', 'measurements', 'minTcb', 'crl', 'roots', 'product', 'guestPolicy'].includes(k)) bad(`${w}: unknown field ${k}`);
    if (r.roots !== undefined && allowTestRoots !== true) bad(`${w}.roots: a non-AMD root pin is for programmatic tests only (allowTestRoots); production trusts AMD's pinned ARK`);
    let u; try { u = new URL(String(r.url)); } catch { bad(`${w}.url must be a URL`); }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) bad(`${w}.url must be an https origin (no path, query or credentials)`);
    if (seen.has(u.origin)) bad(`${w}.url repeats a replica`); seen.add(u.origin);
    let cfg; try { cfg = canonicalDirectConfig(r.config); } catch (e) { bad(`${w}.config: ${e.message}`); }
    if (cfg.chainVerifier?.expose !== 'attested') bad(`${w}.config binds no attested chain verifier (chainVerifier.expose "attested")`);
    if (cfg.chainVerifier.unsafeSigner !== signer) bad(`${w}.config pins sequencer ${cfg.chainVerifier.unsafeSigner}, not the caller's ${signer}`);
    const measurements = Array.isArray(r.measurements) ? r.measurements.map((m) => String(m).toLowerCase()) : [];
    if (!measurements.length || measurements.length > 8 || !measurements.every((m) => HEX96.test(m))) bad(`${w}.measurements: 1 to 8 96-hex launch digests of the reviewed image`);
    const minTcb = checkMinTcbFloor(r.minTcb, `${w}.minTcb`);
    if (r.crl !== undefined && r.crl !== 'required') bad(`${w}.crl: only "required" (the verifier's default) is accepted here`);
    return Object.freeze({ url: u.origin, config: cfg, digest: configDigest(cfg), measurements: Object.freeze(measurements), minTcb,
      ...(r.roots !== undefined ? { roots: r.roots } : {}), ...(r.product !== undefined ? { product: r.product } : {}), ...(r.guestPolicy !== undefined ? { guestPolicy: r.guestPolicy } : {}) });
  }));
}

/** The exact acceptance rule: verifyMeasuredControl's outcome with every check but the registry true. */
export function attestedOutcome(v) {
  const c = v?.checks || {};
  const ok = v?.status === 'pending' && c.statement === true && c.config === true && c['endpoint key'] === true && c.report === true && c.supervisor === true
    && c.registry === null && /^[0-9a-f]{64}$/.test(String(v.identity?.controlTlsSpkiSha256 || '')) && HEX96.test(String(v.identity?.measurement || ''));
  return ok ? { status: 'attested', spki: v.identity.controlTlsSpkiSha256, measurement: v.identity.measurement, bootId: v.identity.bootId }
    : { status: v?.status === 'rejected' ? 'rejected' : 'unavailable', reasons: (v?.reasons || []).slice(-6) };
}

/** One POST over a fresh TLS connection whose peer SPKI must be `pinSha256` before any byte is sent. -> { status, body }
 *  sockets: an optional Set the live socket is kept in until it closes (the owner destroys them on close()). */
export function pinnedPost(origin, path, body, { pinSha256, timeoutMs = 15000, maxBytes = MAX_VERIFIER_ANSWER_BYTES, signal, sockets = null } = {}) {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted('aborted'));
    let settled = false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const socket = tls.connect({ host, port: Number(u.port || 443), rejectUnauthorized: false, ...(/^[\d.]+$|:/.test(host) ? {} : { servername: host }), ALPNProtocols: ['http/1.1'] });
    sockets?.add(socket); socket.once('close', () => sockets?.delete(socket));
    const finish = (f, v) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); if (f === reject) socket.destroy(); f(v); };
    const timer = setTimeout(() => finish(reject, new Error(`no answer within ${timeoutMs} ms`)), Math.max(1, timeoutMs));
    const onAbort = () => finish(reject, aborted('aborted'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    socket.once('error', (e) => finish(reject, e));
    socket.once('close', () => finish(reject, new Error('connection closed before an answer')));
    socket.once('secureConnect', () => {
      let spki;
      try { spki = new X509Certificate(socket.getPeerCertificate(true).raw).publicKey.export({ type: 'spki', format: 'der' }); }
      catch (e) { return finish(reject, new Error(`no peer certificate: ${e.message}`)); }
      if (sha256Hex(spki) !== pinSha256) return finish(reject, Object.assign(new Error('the endpoint presented a key other than the attested control key'), { pinMismatch: true }));
      // createConnection (no agent): HTTP goes over THIS already-pinned socket, never a new connection
      const req = http.request({ createConnection: () => socket, method: 'POST', path,
        headers: { host: u.host, 'content-type': 'application/json', 'content-length': body.length, connection: 'close' } }, (res) => {
        let size = 0; const chunks = [];
        res.on('data', (c) => { size += c.length; if (size > maxBytes) finish(reject, new Error(`answer exceeds ${maxBytes} bytes`)); else chunks.push(c); });
        res.on('end', () => finish(resolve, { status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on('error', (e) => finish(reject, e));
      });
      req.on('error', (e) => finish(reject, e));
      req.end(body);
    });
  });
}

/** Wait for `p`, but settle at once on the deadline or the caller's abort (p keeps running, bounded by its own budget). */
function within(p, deadline, signal, what) {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (signal?.aborted) return reject(aborted('aborted'));
    if (left <= 0) return reject(aborted(`deadline passed before ${what}`));
    const t = setTimeout(() => { cleanup(); reject(aborted(`deadline passed during ${what}`)); }, left);
    const onAbort = () => { cleanup(); reject(aborted('aborted')); };
    const cleanup = () => { clearTimeout(t); signal?.removeEventListener?.('abort', onAbort); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    p.then((v) => { cleanup(); resolve(v); }, (e) => { cleanup(); reject(e); });
  });
}

/**
 * createAttestedVerifier({ replicas, unsafeSigner, collateral, reattestMs, timeoutMs, allowTestRoots, log }) -> a verifier
 * object for LeaseReader({authority:'verifier', verifier}) and verified-chain snapshots:
 * { request(method, params, ms, signal), attest(), status(), close() }. Its status is computed here only.
 */
// verifyNow: PROGRAMMATIC ONLY (tests): the clock the hardware report and AMD collateral are judged at (verifyMeasuredControl's
// own `now`); absent, the real time. No configuration sets it.
export function createAttestedVerifier({ replicas, unsafeSigner, collateral, reattestMs = 10 * 60_000, timeoutMs = 15000, allowTestRoots = false, verifyNow = null, log = () => {} } = {}) {
  const list = checkAttestedReplicas(replicas, { unsafeSigner, allowTestRoots });
  if (!collateral || typeof collateral !== 'object' || typeof collateral.chain !== 'function') bad('collateral: an AMD collateral adapter (verifier/collateral.mjs) is required; pre-seed it where possible');
  if (!Number.isSafeInteger(reattestMs) || reattestMs < 30_000 || reattestMs > 3_600_000) bad('reattestMs: 30000 to 3600000');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) bad('timeoutMs: 100 to 120000');
  const state = list.map(() => ({ status: 'unattested', spki: null, measurement: null, bootId: null, attestedAt: 0, reasons: [], pending: null }));
  const sockets = new Set();
  let id = 0, closed = false;
  // ONE attestation per replica at a time, bounded by `budgetMs`; every waiter shares it and settles on its own deadline
  function attest(i, budgetMs) {
    const r = list[i], s = state[i];
    if (s.pending) return s.pending;
    s.pending = (async () => {
      const v = await verifyMeasuredControl({ url: r.url, collateral, timeoutMs: Math.max(100, Math.min(timeoutMs, budgetMs)), ...(verifyNow ? { now: verifyNow() } : {}),
        expect: { config: r.config, measurements: [...r.measurements], minTcb: r.minTcb,
          ...(r.roots !== undefined ? { roots: r.roots } : {}), ...(r.product !== undefined ? { product: r.product } : {}), ...(r.guestPolicy !== undefined ? { guestPolicy: r.guestPolicy } : {}) } });
      const o = attestedOutcome(v);
      Object.assign(s, o.status === 'attested' ? { status: 'attested', spki: o.spki, measurement: o.measurement, bootId: o.bootId, attestedAt: Date.now(), reasons: [] }
        : { status: o.status, spki: null, measurement: null, bootId: null, attestedAt: 0, reasons: o.reasons });
      log(`[attested-verifier] ${r.url}: ${s.status}${s.status === 'attested' ? ` (measurement ${s.measurement.slice(0, 16)}…, boot ${s.bootId})` : `: ${s.reasons.join(' | ').slice(0, 300)}`}`);
      return s.status === 'attested';
    })().finally(() => { s.pending = null; });
    return s.pending;
  }
  const fresh = (s) => s.status === 'attested' && Date.now() - s.attestedAt < reattestMs;
  async function request(method, params = [], ms = timeoutMs, signal) {
    if (closed) throw new Error('attested verifier: closed');
    if (!READ.has(method)) throw new Error(`attested verifier: ${method} is not a verifier read`);
    const deadline = Date.now() + Math.max(1, Math.min(Number(ms) || timeoutMs, timeoutMs * list.length));
    // one controller for this request: the caller's abort, or the deadline, ends every step it started
    const ac = new AbortController(), stop = () => ac.abort();
    if (signal?.aborted) throw aborted('aborted');
    signal?.addEventListener?.('abort', stop, { once: true });
    const dl = setTimeout(stop, deadline - Date.now());
    try {
      const reqId = ++id, body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }));
      const failures = [];
      for (let i = 0; i < list.length; i++) {
        if (ac.signal.aborted) throw aborted(signal?.aborted ? 'aborted' : 'deadline passed');
        const s = state[i];
        if (!fresh(s)) {
          let ok = false;
          try { ok = await within(attest(i, deadline - Date.now()), deadline, ac.signal, `attesting ${list[i].url}`); }
          catch (e) { if (e.code === 'ABORT_ERR') throw signal?.aborted ? aborted('aborted') : aborted(`deadline passed while attesting ${list[i].url}`); failures.push(`${list[i].url}: ${e.message}`); continue; }
          if (!ok) { failures.push(`${list[i].url}: ${s.status}`); continue; }
        }
        let got;
        try { got = await pinnedPost(list[i].url, CHAIN_VERIFIER_ROUTE, body, { pinSha256: s.spki, timeoutMs: deadline - Date.now(), signal: ac.signal, sockets }); }
        catch (e) {
          if (e.code === 'ABORT_ERR') throw signal?.aborted ? aborted('aborted') : aborted('deadline passed');
          if (e.pinMismatch) Object.assign(s, { status: 'unattested', spki: null, attestedAt: 0 });
          failures.push(`${list[i].url}: ${e.message}`); continue;
        }
        if (got.status !== 200) { failures.push(`${list[i].url}: HTTP ${got.status}`); continue; }
        let j; try { j = JSON.parse(got.body.toString('utf8')); } catch { failures.push(`${list[i].url}: not JSON`); continue; }
        if (!j || typeof j !== 'object' || j.jsonrpc !== '2.0' || j.id !== reqId) { failures.push(`${list[i].url}: not the answer to this request`); continue; }
        // a JSON-RPC error IS the attested verifier's answer (a refusal: missing witness, stale head...): never retried elsewhere
        if (j.error) throw Object.assign(new Error(`attested verifier ${list[i].url}: ${String(j.error.message || 'error').slice(0, 200)}`), { code: j.error.code, data: j.error.data });
        return j.result;
      }
      throw new Error(`attested verifier: no attested replica answered (${failures.join('; ').slice(0, 600)})`);
    } finally { clearTimeout(dl); signal?.removeEventListener?.('abort', stop); }
  }
  const client = {
    request,
    attest: async () => { const out = []; for (let i = 0; i < list.length; i++) out.push(await attest(i, timeoutMs).catch(() => false)); return out; },
    status: () => ({ authority: 'attested-verifier', execution: 'remote verifier inside a SEV-SNP-attested measured guest (HOST_DATA-bound config)',
      localProof: false, providerQuorum: false, replicaQuorum: false, tier: 'unsafe', finality: 'none', closed,
      openSockets: sockets.size, pendingAttestations: state.filter((s) => s.pending).length,
      replicas: list.map((r, i) => ({ url: r.url, configDigest: r.digest, status: fresh(state[i]) ? 'attested' : state[i].status === 'attested' ? 'expired' : state[i].status,
        measurement: state[i].measurement, bootId: state[i].bootId, attestedAt: state[i].attestedAt || null, reasons: [...state[i].reasons] })) }),
    close: () => { closed = true; for (const s of sockets) s.destroy(); sockets.clear(); },
  };
  return markAttestedVerifierClient(Object.freeze(client));
}
