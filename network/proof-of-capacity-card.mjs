// A capacity check of THE CARD a host sells by masked offload (the "shielded" card of a confidential server: a GPU on
// the untrusted host, driven from inside the confidential VM by shielded/worker.py's protocol), as a further check for
// createCapacityChecker's `also` (proof-of-capacity-host.mjs).
//
// THE WORK is the operation the card is sold for: the worker's FIELD_GEMM, y = x.W over Z_M, on a weight matrix and on
// vectors the CHECKER's seeds determine. The checker does not repeat it. It checks rows of the answer with
// preprocessed Freivalds (the check the guest itself runs on every product, shielded.mjs): one pass over W, then K + N
// operations per row, against K x N per row for whoever computes it.
//
// Three requests, POST CARD_CHECK_PATH:
//   prepare  the signed challenge (card, K, N, batch, frames, a nonce). The host derives W from the challenge and
//            installs it on the card. Not timed: moving the matrix to the card is not what is sold.
//   run      a second value the checker draws only now. The host derives frames x batch vectors from it, has the card
//            multiply them, and answers with the SHA-256 of every product row, signed by its proof key. Timed.
//   open     the rows the checker picks after it holds those digests. Each must hash to its digest and pass Freivalds.
//            A host that returned made-up digests for a tenth of the rows is caught by 24 opened rows 92 times in 100.
//
// HOW MUCH is asked follows what the host ADVERTISES: the card's rate in the capacity record its operator key signs
// (shieldedCards[].gmacPerSec, the worker's own measurement) times the share of the card it says is free now, for
// `targetSec` seconds. The answer to `run` must come back within slack x that + graceMs.
//
// WHAT A PASS SAYS: that many correct field products came back in that time, through the same path a tenant's products
// take. It does not say which silicon made them (a processor fast enough is a card of that rate, and may sell as one),
// and nothing about the card's memory: the matrix here is megabytes.
//
// Vectors are small on purpose: |x| <= 31 and |w| <= 119 keep every true product far inside the field (K = 4096: the
// chance that one output leaves (-M/2, M/2) is below e^-400), so the balanced value the worker returns IS the integer
// product and one Freivalds identity over an unrelated prime checks it. With |x| <= 31 a value is its own residue in
// all three planes.
//
// No package import here (see proof-of-capacity.mjs).
import {createHash, randomBytes} from 'node:crypto';
import net from 'node:net';
import {capacityDomain} from './proof-of-capacity.mjs';
import {createChallengeGate} from './proof-of-capacity-host.mjs';

export const CARD_CHECK = 'card', CARD_CHECK_PATH = '/v1/host/card-check';
export const CARD_DEFAULTS = Object.freeze({k: 4096, n: 4096, batch: 32,
  targetSec: 2,          // the run is sized to take the advertised rate this long
  maxFrames: 256,        // whatever the rate (a faster card is then timed over a shorter run)
  slack: 3, graceMs: 2500, opens: 24, prepareTimeoutMs: 90000, timeoutMs: 60000});
export const CARD_LIMITS = Object.freeze({k: 16384, n: 16384, batch: 64, frames: 512, opens: 64, weightBytes: 1 << 28, sessionMs: 180000});
const HEX32 = /^0x[0-9a-f]{64}$/, QK = 32, W_MAX = 119, X_MAX = 31;
const P2 = 2147483647, S_RANGE = 1 << 20, REPS = 2;
const need = (ok, what) => { if (!ok) throw new Error(what); };
const hex = s => Buffer.from(String(s).slice(2), 'hex');
const sha = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
const stream = (label, seed, bytes, extra = Buffer.alloc(0)) => createHash('shake256', {outputLength: bytes}).update(label).update(hex(seed)).update(extra).digest();
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const validShape = c => Number.isInteger(c.k) && c.k >= QK && c.k <= CARD_LIMITS.k && c.k % QK === 0 && Number.isInteger(c.n) && c.n >= 1 && c.n <= CARD_LIMITS.n &&
  c.k * c.n <= CARD_LIMITS.weightBytes && Number.isInteger(c.batch) && c.batch >= 1 && c.batch <= CARD_LIMITS.batch &&
  Number.isInteger(c.frames) && c.frames >= 1 && c.frames <= CARD_LIMITS.frames;

// ---- the work, from the seeds ------------------------------------------------------------------------------------------
/** W: K x N fixed weights in [-119, 119], row-major (w[k * N + j]), from the challenge's seed. */
export function cardWeights(seed, k, n) {
  const b = stream('enclave-card-check/w', seed, k * n), w = new Int8Array(k * n);
  for (let i = 0; i < w.length; i++) w[i] = (b[i] % (2 * W_MAX + 1)) - W_MAX;
  return w;
}
/** Vector `i` of a run: K values in [-31, 31]. */
export function cardVector(run, i, k) {
  const b = stream('enclave-card-check/x', run, k, u32(i)), x = new Int8Array(k);
  for (let j = 0; j < k; j++) x[j] = (b[j] % (2 * X_MAX + 1)) - X_MAX;
  return x;
}
/** One frame's activation as the worker takes it: planes int8[3][m][K] (a small value is its own residue in each). */
export function cardFrame(run, frame, batch, k) {
  const plane = Buffer.alloc(batch * k);
  for (let r = 0; r < batch; r++) plane.set(new Uint8Array(cardVector(run, frame * batch + r, k).buffer), r * k);
  return Buffer.concat([plane, plane, plane]);
}
/** The products in software: m rows of N int32 LE. What a card computes; here for the tests and a host without one. */
export function softwareGemm(w, k, n, planes, m) {
  const out = Buffer.alloc(m * n * 4), x = new Int8Array(planes.buffer, planes.byteOffset, m * k), acc = new Float64Array(n);
  for (let r = 0; r < m; r++) {
    acc.fill(0);
    for (let i = 0; i < k; i++) { const v = x[r * k + i]; if (v) for (let j = 0, o = i * n; j < n; j++) acc[j] += v * w[o + j]; }
    for (let j = 0; j < n; j++) out.writeInt32LE(acc[j], (r * n + j) * 4);
  }
  return out;
}

/** Preprocessed Freivalds over W, with a secret only this verifier holds: check(x, row) for one product row. */
export class CardVerifier {
  constructor(w, k, n, random = () => randomBytes(4).readUInt32LE() / 4294967296) {
    this.k = k; this.n = n; this.s = []; this.st = [];
    for (let rep = 0; rep < REPS; rep++) {
      const s = new Float64Array(n), st = new Float64Array(k);
      for (let j = 0; j < n; j++) s[j] = 1 + Math.floor(random() * (S_RANGE - 1));
      for (let i = 0; i < k; i++) { let acc = 0; for (let j = 0, o = i * n; j < n; j++) acc += w[o + j] * s[j]; st[i] = ((acc % P2) + P2) % P2; }
      this.s.push(s); this.st.push(st);
    }
  }
  check(x, row) {
    if (row.length !== this.n * 4) return false;
    for (let rep = 0; rep < REPS; rep++) {
      let lhs = 0, rhs = 0;
      for (let j = 0; j < this.n; j++) lhs = (lhs + row.readInt32LE(j * 4) * this.s[rep][j]) % P2;
      for (let i = 0; i < this.k; i++) rhs = (rhs + x[i] * this.st[rep][i]) % P2;
      if (((lhs % P2) + P2) % P2 !== ((rhs % P2) + P2) % P2) return false;
    }
    return true;
  }
}

// ---- the card, over the worker's wire (shielded/wire.py: | cmd u8 | len u64 LE | payload |, reply byte 0 = status) --------
const CMD = {HELLO: 0, ALLOC_BUFFER: 1, SET_TENSOR: 8, GRAPH_INSTALL: 10, FIELD_GEMM: 12};
const frameOf = (cmd, payload = Buffer.alloc(0)) => { const h = Buffer.alloc(9); h[0] = cmd; h.writeBigUInt64LE(BigInt(payload.length), 1); return Buffer.concat([h, payload]); };
/**
 * -> open({endpoint: 'host:port', w, k, n, batch}) -> {device, gemm(planes, m) -> m x N int32 LE, close()}
 * encoding 'q8' sends W as the card's production kernel takes it (q8_0 quants with one fp16 scale per 32 rows; the
 * scale is 1/256, under which the kernel's fixed weight IS the quant); 'w' sends the pre-encoded (N, K) form, the one a
 * worker without a card computes (shielded/worker.py --device cpu).
 */
export function shieldedCardDriver({encoding = 'q8', timeoutMs = 60000, connect = net.createConnection} = {}) {
  need(encoding === 'q8' || encoding === 'w', 'encoding');
  return async function open({endpoint, w, k, n, batch}) {
    const m = /^(\[[0-9a-f:]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(String(endpoint || ''));
    need(m && +m[2] >= 1 && +m[2] <= 65535, 'card endpoint: host:port');
    let buf = Buffer.alloc(0), dead = null; const waiters = [];
    const sock = await new Promise((resolve, reject) => {
      const s = connect({host: m[1].replace(/^\[|\]$/g, ''), port: +m[2]}, () => { s.setNoDelay(true); resolve(s); });
      s.once('error', reject); s.setTimeout(timeoutMs, () => s.destroy(new Error('card worker timeout')));
    });
    const fail = e => { dead = dead || e; for (const x of waiters.splice(0)) x.reject(dead); };
    sock.on('error', fail); sock.on('close', () => fail(new Error('card worker closed')));
    sock.on('data', d => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= 9 && waiters.length) {
        const size = Number(buf.readBigUInt64LE(1)); if (buf.length < 9 + size) return;
        const status = buf[0], payload = Buffer.from(buf.subarray(9, 9 + size)); buf = buf.subarray(9 + size);
        const x = waiters.shift(); if (status !== 0) x.reject(new Error('card worker refused: ' + payload.toString('utf8').slice(0, 160))); else x.resolve(payload);
      }
    });
    const call = (cmd, payload) => new Promise((resolve, reject) => { if (dead) return reject(dead); waiters.push({resolve, reject}); sock.write(frameOf(cmd, payload)); });
    const alloc = async (size, role) => Number((await call(CMD.ALLOC_BUFFER, Buffer.concat([u64(size), u32(role.length), Buffer.from(role, 'ascii')]))).readBigUInt64LE(0));
    const set = (bid, off, data) => call(CMD.SET_TENSOR, Buffer.concat([u64(bid), u64(off), u64(data.length), data]));
    try {
      const hello = JSON.parse((await call(CMD.HELLO, Buffer.from([1, 0, 0, 0]))).toString());
      const node = {op: 'FIELD_GEMM', id: 'capacity', K: k, N: n, max_m: batch};
      if (encoding === 'w') {
        const t = Buffer.alloc(k * n); for (let i = 0; i < k; i++) for (let j = 0, o = i * n; j < n; j++) t[j * k + i] = w[o + j] & 255;
        const bid = await alloc(t.length, 'weights'); await set(bid, 0, t); node.w = {bid, offset: 0};
      } else {
        const scales = Buffer.alloc((k / QK) * n * 2); for (let i = 0; i < scales.length; i += 2) scales.writeUInt16LE(0x1c00, i);   // fp16 1/256
        const at = Math.ceil(k * n / 64) * 64, bid = await alloc(at + scales.length, 'weights');
        await set(bid, 0, Buffer.from(w.buffer, w.byteOffset, w.byteLength)); await set(bid, at, scales);
        node.wq = {bid, offset: 0}; node.wd = {bid, offset: at};
      }
      const yAt = Math.ceil(3 * batch * k / 64) * 64, abid = await alloc(yAt + batch * n * 4, 'activations');
      node.x = {bid: abid, offset: 0}; node.y = {bid: abid, offset: yAt};
      await call(CMD.GRAPH_INSTALL, Buffer.from(JSON.stringify({nodes: [node], outputs: [{bid: abid, offset: yAt, nbytes: batch * n * 4}]})));
      return {device: String(hello.device || '').slice(0, 64),
        async gemm(planes, rows) {
          const y = await call(CMD.FIELD_GEMM, Buffer.concat([u32(1), u32(rows), u32(0), planes]));
          need(y.length === rows * n * 4, 'the card worker answered another size than the request defines'); return y;
        },
        close() { try { sock.destroy(); } catch {} }};
    } catch (e) { try { sock.destroy(); } catch {} throw e; }
  };
}
/** The same interface with no card: the products computed here. For tests, and never what a host should sell as a card. */
export const softwareCardDriver = () => async ({w, k, n}) => ({device: 'software', gemm: async (planes, m) => softwareGemm(w, k, n, planes, m), close() {}});

// ---- the messages -------------------------------------------------------------------------------------------------------
const CHALLENGE = [{name: 'epoch', type: 'uint64'}, {name: 'checker', type: 'bytes32'}, {name: 'target', type: 'bytes32'}, {name: 'seed', type: 'bytes32'},
  {name: 'nonce', type: 'bytes32'}, {name: 'card', type: 'uint32'}, {name: 'k', type: 'uint32'}, {name: 'n', type: 'uint32'}, {name: 'batch', type: 'uint32'}, {name: 'frames', type: 'uint32'}];
const ANSWER = [{name: 'epoch', type: 'uint64'}, {name: 'checker', type: 'bytes32'}, {name: 'target', type: 'bytes32'}, {name: 'nonce', type: 'bytes32'},
  {name: 'run', type: 'bytes32'}, {name: 'root', type: 'bytes32'}];
export const cardChallengeMessage = (domain, c) => ({domain: capacityDomain(domain), types: {CardChallenge: CHALLENGE}, primaryType: 'CardChallenge',
  message: {epoch: BigInt(c.epoch), checker: c.checker, target: c.target, seed: c.seed, nonce: c.nonce, card: c.card, k: c.k, n: c.n, batch: c.batch, frames: c.frames}});
export const cardAnswerMessage = (domain, a) => ({domain: capacityDomain(domain), types: {CardAnswer: ANSWER}, primaryType: 'CardAnswer',
  message: {epoch: BigInt(a.epoch), checker: a.checker, target: a.target, nonce: a.nonce, run: a.run, root: a.root}});
// the matrix's seed: the challenge's nonce under the epoch's seed
const weightSeed = c => '0x' + sha(hex(c.seed), hex(c.nonce)).toString('hex');
const validChallenge = c => c && typeof c === 'object' && c.version === 1 && Number.isSafeInteger(c.epoch) && c.epoch >= 0 &&
  [c.checker, c.target, c.seed, c.nonce].every(v => HEX32.test(String(v))) && c.checker !== c.target &&
  Number.isInteger(c.card) && c.card >= 0 && c.card < 16 && validShape(c) && typeof c.signature === 'string';

/**
 * The checked host's side: POST CARD_CHECK_PATH. -> answer(body) -> {status, body}
 *   hostId, domain, reader, proofKeyOf, sign, recover: as createCapacityResponder
 *   cards() -> [{id, endpoint}]: the cards this host sells now; open: a driver (shieldedCardDriver())
 * One check at a time, one per checker and epoch, and a check that is not finished in CARD_LIMITS.sessionMs is dropped.
 */
export function createCardResponder({hostId, domain, reader, proofKeyOf, sign, recover, cards, open, now = Date.now}) {
  need(typeof cards === 'function' && typeof open === 'function', 'the host\'s cards and a driver');
  const admit = createChallengeGate({hostId, reader, proofKeyOf, recover});
  const done = new Set();    // "<epoch>:<checker>" that had their check
  let session = null;        // {key, nonce, c, card, state: 'ready' | 'ran', rows, at}
  const no = (status, error) => ({status, body: {error}});
  const drop = () => { if (session) { try { session.card.close(); } catch {} session = null; } };
  const mine = b => session && b && b.nonce === session.nonce && b.checker === session.c.checker && b.epoch === session.c.epoch ? session : null;
  return async function answer(b) {
    if (session && now() - session.at > CARD_LIMITS.sessionMs) drop();
    if (b?.phase === 'prepare') {
      const c = b;
      if (!validChallenge(c)) return no(400, 'not a card challenge');
      const gate = await admit(c, cardChallengeMessage(domain, c));
      if (gate.error) return no(gate.status, gate.error);
      const key = `${gate.epoch}:${c.checker}`;
      if (done.has(key)) return no(429, 'already checked by this host in this epoch');
      if (session) return session.key === key && session.nonce === c.nonce && session.state === 'ready' ? {status: 200, body: {ready: true, device: session.card.device}} : no(503, 'busy with another check');
      const sold = (await cards()).find(x => x && x.id === c.card && x.endpoint);
      if (!sold) return no(404, 'no such card');
      session = {key, nonce: c.nonce, c, state: 'opening', card: {close() {}}, at: now()};
      const held = session;
      try {
        const card = await open({endpoint: sold.endpoint, w: cardWeights(weightSeed(c), c.k, c.n), k: c.k, n: c.n, batch: c.batch});
        if (session !== held) { card.close(); return no(503, 'the check was dropped'); }
        held.card = card; held.state = 'ready';
      } catch (e) { if (session === held) session = null; return no(503, 'the card did not take the work: ' + String(e?.message || e).slice(0, 120)); }
      for (const k of done) if (!k.startsWith(gate.epoch + ':')) done.delete(k);
      return {status: 200, body: {ready: true, device: held.card.device}};
    }
    if (b?.phase === 'run') {
      const s = mine(b);
      if (!s || s.state !== 'ready' || !HEX32.test(String(b.run))) return no(409, 'no prepared check for this');
      s.state = 'running';
      const {c} = s, hashes = [], rows = [];
      try {
        for (let f = 0; f < c.frames; f++) {
          const y = await s.card.gemm(cardFrame(b.run, f, c.batch, c.k), c.batch);
          for (let r = 0; r < c.batch; r++) { const row = y.subarray(r * c.n * 4, (r + 1) * c.n * 4); rows.push(row); hashes.push(sha(row)); }
        }
      } catch (e) { drop(); return no(503, 'the card did not finish the work: ' + String(e?.message || e).slice(0, 120)); }
      const digests = Buffer.concat(hashes), root = '0x' + sha(digests).toString('hex');
      const a = {version: 1, epoch: c.epoch, checker: c.checker, target: hostId, nonce: c.nonce, run: b.run, root};
      const signature = await sign(cardAnswerMessage(domain, a));
      if (session !== s) return no(503, 'the check was dropped');
      s.rows = rows; s.state = 'ran'; done.add(s.key);
      return {status: 200, body: {...a, digests: digests.toString('base64'), signature}};
    }
    if (b?.phase === 'open') {
      const s = mine(b);
      if (!s || s.state !== 'ran') return no(409, 'no finished run for this');
      const total = s.c.frames * s.c.batch, want = b.rows;
      if (!Array.isArray(want) || !want.length || want.length > CARD_LIMITS.opens || !want.every(i => Number.isInteger(i) && i >= 0 && i < total)) { drop(); return no(400, 'rows to open'); }
      const body = {rows: Buffer.concat(want.map(i => s.rows[i])).toString('base64')};
      drop();
      return {status: 200, body};
    }
    return no(400, 'phase: prepare, run or open');
  };
}

/**
 * The checker's side: an `also` check. -> async (target, row, {epoch, seed, claim}) -> {name, ok: true|false|null, why, evidence?}
 *   host (the checker's id), domain, sign (its proof key), recover; fetch
 *   k, n, batch, targetSec, maxFrames, slack, graceMs, opens: see CARD_DEFAULTS; enforce: false records and fails nobody
 * not judged (ok null): the host advertises no card, or none of it as free; it says "not now" (409, 429, 503).
 * fail: it advertises a card and does not answer for it (404), or does not take or finish the work inside the deadline;
 *   an answer that is not for this challenge or not signed by its proof key; a run slower than slack x the time its own
 *   advertised rate gives + graceMs; an opened row that is not the one committed or is not the product.
 */
export function createCardCheck({host, domain, sign, recover, fetch = globalThis.fetch, k = CARD_DEFAULTS.k, n = CARD_DEFAULTS.n, batch = CARD_DEFAULTS.batch,
  targetSec = CARD_DEFAULTS.targetSec, maxFrames = CARD_DEFAULTS.maxFrames, slack = CARD_DEFAULTS.slack, graceMs = CARD_DEFAULTS.graceMs, opens = CARD_DEFAULTS.opens,
  prepareTimeoutMs = CARD_DEFAULTS.prepareTimeoutMs, timeoutMs = CARD_DEFAULTS.timeoutMs, enforce = true, now = Date.now, random = randomBytes}) {
  need(HEX32.test(String(host)) && typeof recover === 'function' && validShape({k, n, batch, frames: 1}), 'card check: host id, signature recovery and a shape');
  const frameGmac = batch * k * n / 1e9;
  return async function cardCheck(target, row, {epoch, seed, claim}) {
    const out = (ok, why, evidence) => ({name: CARD_CHECK, ok: ok === false && !enforce ? null : ok, why: (ok === false && !enforce ? 'recorded, not enforced: ' : '') + String(why).slice(0, 240), ...(evidence ? {evidence} : {})});
    const sold = (claim?.cards || []).filter(c => c.gmacPerSec > 0);
    if (!sold.length) return out(null, 'the host advertises no card with a rate');
    // which card: by the seed and the checker, as the app is chosen
    const card = [...sold].sort((a, b) => (sha(hex(seed), hex(host), u32(a.id)).toString('hex') < sha(hex(seed), hex(host), u32(b.id)).toString('hex') ? -1 : 1))[0];
    const rate = card.gmacPerSec * card.share;
    if (!(rate > 0)) return out(null, `card ${card.id}: none of it is advertised as free now`);
    const frames = Math.max(1, Math.min(maxFrames, CARD_LIMITS.frames, Math.ceil(rate * targetSec / frameGmac)));
    const gmac = frames * frameGmac, allowMs = Math.min(timeoutMs, Math.ceil(slack * gmac / rate * 1000 + graceMs));
    const asked = {epoch, card: card.id, k, n, batch, frames, gmac: +gmac.toFixed(3), advertised: {gmacPerSec: card.gmacPerSec, share: card.share}, allowMs};
    const c = {phase: 'prepare', version: 1, epoch, checker: host, target, seed, nonce: '0x' + random(32).toString('hex'), card: card.id, k, n, batch, frames};
    c.signature = await sign(cardChallengeMessage(domain, c));
    const post = async (body, ms) => {
      const res = await fetch(String(row.endpoint).replace(/\/+$/, '') + CARD_CHECK_PATH, {method: 'POST', redirect: 'error', headers: {'content-type': 'application/json'},
        body: JSON.stringify(body), signal: AbortSignal.timeout(ms)});
      return {status: res.status, body: res.ok ? await res.json() : null};
    };
    const notNow = s => [409, 429, 503].includes(s);
    // the verifier's own preparation, before any clock: the matrix and its Freivalds vectors
    const verifier = new CardVerifier(cardWeights(weightSeed(c), k, n), k, n);
    let r;
    try { r = await post(c, prepareTimeoutMs); } catch (e) { return out(false, `card ${card.id}: no answer to prepare (${String(e?.name === 'TimeoutError' ? 'deadline' : e?.message || e).slice(0, 80)})`, asked); }
    if (notNow(r.status)) return out(null, `card ${card.id}: the host answered ${r.status} to prepare`, asked);
    if (r.status !== 200 || r.body?.ready !== true) return out(false, `card ${card.id}: advertised, and the host does not answer for it (HTTP ${r.status})`, asked);
    const run = '0x' + random(32).toString('hex'), started = now();
    try { r = await post({phase: 'run', epoch, checker: host, nonce: c.nonce, run}, allowMs + 5000); }
    catch (e) { return out(false, `card ${card.id}: the run did not come back (${String(e?.name === 'TimeoutError' ? `nothing inside ${allowMs + 5000} ms` : e?.message || e).slice(0, 80)})`, asked); }
    const elapsedMs = now() - started, a = r.body, total = frames * batch;
    const measured = {...asked, device: undefined, elapsedMs, gmacPerSec: +(gmac / Math.max(1, elapsedMs) * 1000).toFixed(3)};
    if (notNow(r.status)) return out(null, `card ${card.id}: the host answered ${r.status} to run`, asked);
    if (r.status !== 200 || !a || a.epoch !== epoch || a.checker !== host || a.target !== target || a.nonce !== c.nonce || a.run !== run || !HEX32.test(String(a.root)) ||
        typeof a.digests !== 'string' || typeof a.signature !== 'string') return out(false, `card ${card.id}: the answer is not for this run (HTTP ${r.status})`, measured);
    const digests = Buffer.from(a.digests, 'base64');
    if (digests.length !== total * 32 || '0x' + sha(digests).toString('hex') !== a.root) return out(false, `card ${card.id}: the digests are not ${total} rows under the signed root`, measured);
    let signer = null; try { signer = await recover(cardAnswerMessage(domain, a), a.signature); } catch {}
    if (!signer || signer.toLowerCase() !== String(row.proofKey).toLowerCase()) return out(false, `card ${card.id}: the answer is not signed by the host's proof key`, measured);
    if (elapsedMs > allowMs) return out(false, `card ${card.id}: ${gmac.toFixed(1)} G products took ${elapsedMs} ms, ${measured.gmacPerSec} G/s where ${rate.toFixed(2)} G/s is advertised as free`, measured);
    // only now, with the digests held: which rows to see
    const pick = new Set(); const count = Math.min(opens, total, CARD_LIMITS.opens);
    while (pick.size < count) pick.add(random(4).readUInt32LE() % total);
    const rows = [...pick];
    try { r = await post({phase: 'open', epoch, checker: host, nonce: c.nonce, rows}, timeoutMs); }
    catch (e) { return out(false, `card ${card.id}: the rows were not opened (${String(e?.message || e).slice(0, 80)})`, measured); }
    const opened = r.status === 200 && typeof r.body?.rows === 'string' ? Buffer.from(r.body.rows, 'base64') : null;
    if (!opened || opened.length !== rows.length * n * 4) return out(false, `card ${card.id}: the rows were not opened (HTTP ${r.status})`, measured);
    for (let i = 0; i < rows.length; i++) {
      const y = opened.subarray(i * n * 4, (i + 1) * n * 4);
      if (!sha(y).equals(digests.subarray(rows[i] * 32, rows[i] * 32 + 32))) return out(false, `card ${card.id}: row ${rows[i]} is not the row it committed to`, measured);
      if (!verifier.check(cardVector(run, rows[i], k), y)) return out(false, `card ${card.id}: row ${rows[i]} is not the product`, measured);
    }
    return out(true, `card ${card.id}: ${gmac.toFixed(1)} G products in ${elapsedMs} ms, ${rows.length} rows checked`, {...measured, opened: rows.length, root: a.root, signature: a.signature});
  };
}
