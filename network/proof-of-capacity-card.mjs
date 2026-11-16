// A capacity check of THE CARD a host sells by masked offload (the "shielded" card of a confidential server: a GPU on
// the untrusted host, driven from inside the confidential VM by shielded/worker.py's protocol), as a further check for
// createCapacityChecker's `also` (proof-of-capacity-host.mjs).
//
// THE WORK is the operation the card is sold for, the worker's FIELD_GEMM (y = x.W over Z_M, the kernel a tenant's
// product runs), fed back into itself ON THE CARD (the worker's FIELD_CHAIN, protocol 1.5):
//     x' = ((x.W + pad) mod 63) - 31,   `rounds` times, for `batch` rows side by side
// on a matrix W, starting rows x and pads the CHECKER's seeds determine. Every `stride` products the worker keeps the
// rows and hashes them; only those digests cross the link. The checker repeats none of it. It asks to see a few
// stretches of `stride` products and checks each product with preprocessed Freivalds (the check the guest itself runs
// on every product, shielded.mjs): one pass over W, then K + N operations a product, against K x N for whoever
// computes it.
//
// Three requests, POST CARD_CHECK_PATH:
//   prepare  the signed challenge (card, K, batch, rounds, stride, a nonce). The host derives W from the challenge and
//            installs it on the card. Not timed: moving the matrix to the card is not what is sold.
//   run      a second value the checker draws only now. The starting rows and the pads come from it, so nothing of the
//            chain can be worked before it is known: the pad enters every step, and a stretch started from rows of the
//            host's own choosing still waits for it. The host answers with the root of a Merkle tree over the digests,
//            signed by its proof key. Timed.
//   open     the stretches the checker picks after it holds that root. For each, the host shows the rows it started
//            from and the `stride` products after them. The start must be the committed state before (or the seed's
//            rows), every product must pass Freivalds, and the end must be the committed state after: the chain is one
//            chain. A host that made up a tenth of the stretches is caught by 24 of them 92 times in 100.
//
// HOW MUCH is asked follows what the host ADVERTISES: the card's rate in the capacity record its operator key signs
// (shieldedCards[].gmacPerSec, the worker's own measurement) times the share of the card it says is free now, for
// `targetSec` seconds of it. The answer to `run` must come back within slack x that + graceMs.
//
// THE CLOCK. The first form of this check (2026-11-16) moved every vector in and every product out over the worker's
// socket, and on an RTX 3070 Ti (2,650 G products a second by the worker's own figure) the link set the time, about
// 260 G/s whatever the card: a host advertising ten times the card's rate passed. With the products kept on the card
// a run is the card's time (plus one hash of 1/(stride x N) of the bytes, done while the card works on), so the run
// is as long as the advertised rate makes it and a slower card is late. What the clock holds a host to is in every
// record (`enforcedGmacPerSec`): with the defaults, a card must deliver about 47% of the free rate it advertises
// (1 / (slack + graceMs / targetSec)); the slack is for a card shared with tenants and the grace for the request's
// own travel. A card faster than `maxCommits` stretches cover in `targetSec` is timed over a shorter run, and the
// record says so.
//
// WHAT A PASS SAYS: that many correct field products were made in that time on whatever answers at the card's
// endpoint, with the kernel shape a tenant's products take, and that the stretches opened are the products (exact).
// It does not say which silicon made them (a processor fast enough is a card of that rate, and may sell as one), and
// nothing about the card's memory: the matrix is megabytes and the kept rows a few hundred.
//
// A WORKER WITHOUT FIELD_CHAIN (protocol 1.4 and earlier) cannot be checked and the host answers 501: a card that is
// advertised and cannot show its rate fails where the check is enforced.
//
// Values are small on purpose: |x| <= 31 and |w| <= 119 keep every true product far inside the field (K = 4096: the
// chance that one output leaves (-M/2, M/2) is below e^-400), so the balanced value the worker computes IS the integer
// product and one Freivalds identity over an unrelated prime checks it. With |x| <= 31 a value is its own residue in
// all three planes.
//
// No package import here (see proof-of-capacity.mjs).
import {createHash, randomBytes} from 'node:crypto';
import net from 'node:net';
import {capacityDomain} from './proof-of-capacity.mjs';
import {createChallengeGate} from './proof-of-capacity-host.mjs';

export const CARD_CHECK = 'card', CARD_CHECK_PATH = '/v1/host/card-check';
export const CARD_DEFAULTS = Object.freeze({k: 4096, batch: 32,
  stride: 16,            // products between two kept states: the hash is 1/(stride x N) of the bytes, a stretch opened is stride x N values
  targetSec: 4,          // the run is sized to take the advertised rate this long
  maxCommits: 2048,      // whatever the rate (a faster card is then timed over a shorter run): the kept rows are maxCommits x batch x K bytes of the card
  slack: 1.5, graceMs: 2500, opens: 24, prepareTimeoutMs: 90000, timeoutMs: 60000});
export const CARD_LIMITS = Object.freeze({k: 16384, batch: 64, stride: 64, commits: 4096, opens: 64, weightBytes: 1 << 28, traceBytes: 1 << 29, sessionMs: 180000});
const HEX32 = /^0x[0-9a-f]{64}$/, QK = 32, W_MAX = 119, X_MAX = 31, CHAIN_MOD = 2 * X_MAX + 1;
const P2 = 2147483647, S_RANGE = 1 << 20, REPS = 2;
const need = (ok, what) => { if (!ok) throw new Error(what); };
const hex = s => Buffer.from(String(s).slice(2), 'hex');
const sha = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
const stream = (label, seed, bytes, extra = Buffer.alloc(0)) => createHash('shake256', {outputLength: bytes}).update(label).update(hex(seed)).update(extra).digest();
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const bytesOf = x => Buffer.from(x.buffer, x.byteOffset, x.byteLength);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const validShape = c => int(c.k, QK, CARD_LIMITS.k) && c.k % QK === 0 && c.k * c.k <= CARD_LIMITS.weightBytes && int(c.batch, 1, CARD_LIMITS.batch) &&
  int(c.stride, 1, CARD_LIMITS.stride) && int(c.rounds, c.stride, CARD_LIMITS.commits * c.stride) && c.rounds % c.stride === 0 &&
  (c.rounds / c.stride) * c.batch * c.k <= CARD_LIMITS.traceBytes;

// ---- the work, from the seeds ------------------------------------------------------------------------------------------
/** W: K x N fixed weights in [-119, 119], row-major (w[k * N + j]), from the challenge's seed. */
export function cardWeights(seed, k, n) {
  const b = stream('enclave-card-check/w', seed, k * n), w = new Int8Array(k * n);
  for (let i = 0; i < w.length; i++) w[i] = (b[i] % (2 * W_MAX + 1)) - W_MAX;
  return w;
}
/** Starting row `i` of a run: K values in [-31, 31]. */
export function cardVector(run, i, k) {
  const b = stream('enclave-card-check/x', run, k, u32(i)), x = new Int8Array(k);
  for (let j = 0; j < k; j++) x[j] = (b[j] % CHAIN_MOD) - X_MAX;
  return x;
}
/** Row `i`'s pad: K values in [0, 62], added to every product of that row before it is reduced. */
export function cardPad(run, i, k) {
  const b = stream('enclave-card-check/pad', run, k, u32(i));
  for (let j = 0; j < k; j++) b[j] %= CHAIN_MOD;
  return b;
}
/** A run's starting state and pads as the worker takes them: int8[batch][K] and uint8[batch][K]. */
export const cardStart = (run, batch, k) => ({x: Buffer.concat(Array.from({length: batch}, (_, r) => bytesOf(cardVector(run, r, k)))),
  pad: Buffer.concat(Array.from({length: batch}, (_, r) => cardPad(run, r, k)))});
/** The step between two products: K int32 LE and the row's pad -> the next row, ((y + pad) mod 63) - 31. */
export function chainStep(y, pad, k) {
  const x = new Int8Array(k);
  for (let j = 0; j < k; j++) { const v = (y.readInt32LE(j * 4) + pad[j]) % CHAIN_MOD; x[j] = (v < 0 ? v + CHAIN_MOD : v) - X_MAX; }
  return x;
}
/** The products in software: m rows of N int32 LE from m rows of K int8. What a card computes; here for the tests and a host without one. */
export function softwareGemm(w, k, n, rows, m) {
  const out = Buffer.alloc(m * n * 4), x = new Int8Array(rows.buffer, rows.byteOffset, m * k), acc = new Float64Array(n);
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

// ---- the commitment: a Merkle tree over the digests of the kept rows (leaf c x batch + r: row r after (c + 1) x stride products)
const pair = (a, b) => sha(Buffer.from([1]), a, b);
/** leaves (32 bytes each, concatenated) -> the tree's levels, leaves first; an odd node moves up as it is. */
export function merkleLevels(digests) {
  need(digests.length && digests.length % 32 === 0, 'digests');
  const levels = [Array.from({length: digests.length / 32}, (_, i) => digests.subarray(i * 32, i * 32 + 32))];
  while (levels.at(-1).length > 1) { const p = levels.at(-1), q = []; for (let i = 0; i < p.length; i += 2) q.push(i + 1 < p.length ? pair(p[i], p[i + 1]) : p[i]); levels.push(q); }
  return levels;
}
export const merkleProof = (levels, i) => { const out = []; for (let l = 0; l < levels.length - 1; l++, i >>= 1) if ((i ^ 1) < levels[l].length) out.push(levels[l][i ^ 1]); return Buffer.concat(out); };
/** The root a leaf at `i` of `total` leads to under `proof`, or null when the proof is not that leaf's shape. */
export function merkleRoot(leaf, i, total, proof) {
  if (!int(i, 0, total - 1) || proof.length % 32) return null;
  let h = leaf, at = 0;
  for (let size = total; size > 1; i >>= 1, size = (size + 1) >> 1) {
    if ((i ^ 1) >= size) continue;
    if (at + 32 > proof.length) return null;
    const sib = proof.subarray(at, at + 32); at += 32; h = i & 1 ? pair(sib, h) : pair(h, sib);
  }
  return at === proof.length ? h : null;
}

// ---- the card, over the worker's wire (shielded/wire.py: | cmd u8 | len u64 LE | payload |, reply byte 0 = status) --------
const CMD = {HELLO: 0, ALLOC_BUFFER: 1, SET_TENSOR: 8, GET_TENSOR: 9, GRAPH_INSTALL: 10, FIELD_GEMM: 12, FIELD_CHAIN: 16};
const frameOf = (cmd, payload = Buffer.alloc(0)) => { const h = Buffer.alloc(9); h[0] = cmd; h.writeBigUInt64LE(BigInt(payload.length), 1); return Buffer.concat([h, payload]); };
/**
 * -> open({endpoint: 'host:port', w, k, batch, commits}) -> a card with W installed (square, K x K) and room for `commits` kept states:
 *      device
 *      chain(x, pad, rounds, stride) -> the digests, 32 bytes a row, of the state after every `stride` products (FIELD_CHAIN)
 *      state(c) -> the kept state c: batch x K int8 (after (c + 1) x stride products)
 *      gemm(rows, m) -> m x K int32 LE, the products of m rows (FIELD_GEMM; what an opened stretch is shown with)
 *      close()
 * encoding 'q8' sends W as the card's production kernel takes it (q8_0 quants with one fp16 scale per 32 rows; the
 * scale is 1/256, under which the kernel's fixed weight IS the quant); 'w' sends the pre-encoded (N, K) form, the one a
 * worker without a card computes (shielded/worker.py --device cpu).
 * A worker that does not have FIELD_CHAIN is refused with an error whose code is 'UNSUPPORTED'.
 */
export function shieldedCardDriver({encoding = 'q8', timeoutMs = 60000, connect = net.createConnection} = {}) {
  need(encoding === 'q8' || encoding === 'w', 'encoding');
  return async function open({endpoint, w, k, batch, commits = 1}) {
    const m = /^(\[[0-9a-f:]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(String(endpoint || '')), n = k;
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
      if (!hello.field_chain) throw Object.assign(new Error('the card worker has no FIELD_CHAIN (protocol 1.5)'), {code: 'UNSUPPORTED'});
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
      // one activations buffer: the node's planes and products (FIELD_GEMM's own bindings), then the kept states
      const state = batch * k, yAt = Math.ceil(3 * state / 64) * 64, tAt = Math.ceil((yAt + batch * n * 4) / 64) * 64, abid = await alloc(tAt + commits * state, 'activations');
      node.x = {bid: abid, offset: 0}; node.y = {bid: abid, offset: yAt};
      // every kept state is a declared output: the only regions the worker lets anyone read back
      const outputs = [{bid: abid, offset: yAt, nbytes: batch * n * 4}, ...Array.from({length: commits}, (_, c) => ({bid: abid, offset: tAt + c * state, nbytes: state}))];
      await call(CMD.GRAPH_INSTALL, Buffer.from(JSON.stringify({nodes: [node], outputs})));
      return {device: String(hello.device || '').slice(0, 64),
        async chain(x, pad, rounds, stride) {
          need(x.length === state && pad.length === state && rounds / stride <= commits, 'a chain of the installed shape');
          const d = await call(CMD.FIELD_CHAIN, Buffer.concat([u32(0), u32(batch), u32(rounds), u32(stride), u64(abid), u64(tAt), x, pad]));
          need(d.length === (rounds / stride) * batch * 32, 'the card worker answered another size than the request defines'); return d;
        },
        state: c => call(CMD.GET_TENSOR, Buffer.concat([u64(abid), u64(tAt + c * state), u64(state)])),
        async gemm(rows, m) {
          const y = await call(CMD.FIELD_GEMM, Buffer.concat([u32(1), u32(m), u32(0), rows, rows, rows]));
          need(y.length === m * n * 4, 'the card worker answered another size than the request defines'); return y;
        },
        close() { try { sock.destroy(); } catch {} }};
    } catch (e) { try { sock.destroy(); } catch {} throw e; }
  };
}
/** The same interface with no card: the chain computed here. For tests, and never what a host should sell as a card. */
export const softwareCardDriver = () => async ({w, k, batch}) => {
  const kept = [];
  return {device: 'software', close() {}, state: async c => kept[c], gemm: async (rows, m) => softwareGemm(w, k, k, rows, m),
    async chain(x, pad, rounds, stride) {
      const digests = []; let cur = Buffer.from(x);
      for (let t = 1; t <= rounds; t++) {
        const y = softwareGemm(w, k, k, cur, batch), next = Buffer.alloc(batch * k);
        for (let r = 0; r < batch; r++) next.set(bytesOf(chainStep(y.subarray(r * k * 4, (r + 1) * k * 4), pad.subarray(r * k, (r + 1) * k), k)), r * k);
        cur = next;
        if (t % stride === 0) { kept.push(cur); for (let r = 0; r < batch; r++) digests.push(sha(cur.subarray(r * k, (r + 1) * k))); }
      }
      return Buffer.concat(digests);
    }};
};

// ---- the messages -------------------------------------------------------------------------------------------------------
const CHALLENGE = [{name: 'epoch', type: 'uint64'}, {name: 'checker', type: 'bytes32'}, {name: 'target', type: 'bytes32'}, {name: 'seed', type: 'bytes32'},
  {name: 'nonce', type: 'bytes32'}, {name: 'card', type: 'uint32'}, {name: 'k', type: 'uint32'}, {name: 'batch', type: 'uint32'}, {name: 'rounds', type: 'uint32'}, {name: 'stride', type: 'uint32'}];
const ANSWER = [{name: 'epoch', type: 'uint64'}, {name: 'checker', type: 'bytes32'}, {name: 'target', type: 'bytes32'}, {name: 'nonce', type: 'bytes32'},
  {name: 'run', type: 'bytes32'}, {name: 'root', type: 'bytes32'}];
export const cardChallengeMessage = (domain, c) => ({domain: capacityDomain(domain), types: {CardChallenge: CHALLENGE}, primaryType: 'CardChallenge',
  message: {epoch: BigInt(c.epoch), checker: c.checker, target: c.target, seed: c.seed, nonce: c.nonce, card: c.card, k: c.k, batch: c.batch, rounds: c.rounds, stride: c.stride}});
export const cardAnswerMessage = (domain, a) => ({domain: capacityDomain(domain), types: {CardAnswer: ANSWER}, primaryType: 'CardAnswer',
  message: {epoch: BigInt(a.epoch), checker: a.checker, target: a.target, nonce: a.nonce, run: a.run, root: a.root}});
// the matrix's seed: the challenge's nonce under the epoch's seed
const weightSeed = c => '0x' + sha(hex(c.seed), hex(c.nonce)).toString('hex');
const validChallenge = c => c && typeof c === 'object' && c.version === 2 && Number.isSafeInteger(c.epoch) && c.epoch >= 0 &&
  [c.checker, c.target, c.seed, c.nonce].every(v => HEX32.test(String(v))) && c.checker !== c.target &&
  int(c.card, 0, 15) && validShape(c) && typeof c.signature === 'string';

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
  let session = null;        // {key, nonce, c, card, state: 'opening' | 'ready' | 'running' | 'ran', start, levels, at}
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
        const card = await open({endpoint: sold.endpoint, w: cardWeights(weightSeed(c), c.k, c.k), k: c.k, batch: c.batch, commits: c.rounds / c.stride});
        if (session !== held) { card.close(); return no(503, 'the check was dropped'); }
        held.card = card; held.state = 'ready';
      } catch (e) {
        if (session === held) session = null;
        // a worker that cannot run the check is not "not now": the card is advertised and cannot show its rate
        return e?.code === 'UNSUPPORTED' ? no(501, String(e.message)) : no(503, 'the card did not take the work: ' + String(e?.message || e).slice(0, 120));
      }
      for (const k of done) if (!k.startsWith(gate.epoch + ':')) done.delete(k);
      return {status: 200, body: {ready: true, device: held.card.device}};
    }
    if (b?.phase === 'run') {
      const s = mine(b);
      if (!s || s.state !== 'ready' || !HEX32.test(String(b.run))) return no(409, 'no prepared check for this');
      s.state = 'running';
      const {c} = s, start = cardStart(b.run, c.batch, c.k);
      let digests;
      try { digests = await s.card.chain(start.x, start.pad, c.rounds, c.stride); }
      catch (e) { drop(); return no(503, 'the card did not finish the work: ' + String(e?.message || e).slice(0, 120)); }
      const levels = merkleLevels(digests), root = '0x' + levels.at(-1)[0].toString('hex');
      const a = {version: 2, epoch: c.epoch, checker: c.checker, target: hostId, nonce: c.nonce, run: b.run, root};
      const signature = await sign(cardAnswerMessage(domain, a));
      if (session !== s) return no(503, 'the check was dropped');
      s.start = start; s.levels = levels; s.state = 'ran'; done.add(s.key);
      return {status: 200, body: {...a, signature}};
    }
    if (b?.phase === 'open') {
      const s = mine(b);
      if (!s || s.state !== 'ran') return no(409, 'no finished run for this');
      const {c} = s, total = (c.rounds / c.stride) * c.batch, want = b.stretches;
      if (!Array.isArray(want) || !want.length || want.length > CARD_LIMITS.opens || !want.every(i => int(i, 0, total - 1))) { drop(); return no(400, 'stretches to open'); }
      const kept = new Map(), stretches = [];
      try {
        for (const i of want) {
          const at = Math.floor(i / c.batch), r = i % c.batch, rowOf = buf => buf.subarray(r * c.k, (r + 1) * c.k), pad = rowOf(s.start.pad);
          // the rows this stretch started from: the seed's, or the state kept before it
          if (at && !kept.has(at - 1)) kept.set(at - 1, await s.card.state(at - 1));
          const x = Buffer.from(rowOf(at ? kept.get(at - 1) : s.start.x)), ys = [];
          for (let j = 0, cur = x; j < c.stride; j++) { const y = await s.card.gemm(cur, 1); ys.push(y); cur = bytesOf(chainStep(y, pad, c.k)); }
          stretches.push({x: x.toString('base64'), ys: Buffer.concat(ys).toString('base64'),
            before: at ? merkleProof(s.levels, i - c.batch).toString('base64') : '', after: merkleProof(s.levels, i).toString('base64')});
        }
      } catch (e) { drop(); return no(503, 'the card did not show the work: ' + String(e?.message || e).slice(0, 120)); }
      drop();
      return {status: 200, body: {stretches}};
    }
    return no(400, 'phase: prepare, run or open');
  };
}

/**
 * The checker's side: an `also` check. -> async (target, row, {epoch, seed, claim}) -> {name, ok: true|false|null, why, evidence?}
 *   host (the checker's id), domain, sign (its proof key), recover; fetch
 *   k, batch, stride, targetSec, maxCommits, slack, graceMs, opens: see CARD_DEFAULTS; enforce: false records and fails nobody
 * not judged (ok null): the host advertises no card, or none of it as free; it says "not now" (409, 429, 503).
 * fail: it advertises a card and does not answer for it (404), or its worker cannot run the check (501), or it does
 *   not take or finish the work inside the deadline; an answer that is not for this challenge or not signed by its
 *   proof key; a run slower than slack x the time its own advertised rate gives + graceMs; an opened stretch that does
 *   not start or end at the committed states, or holds a row that is not the product.
 */
export function createCardCheck({host, domain, sign, recover, fetch = globalThis.fetch, k = CARD_DEFAULTS.k, batch = CARD_DEFAULTS.batch, stride = CARD_DEFAULTS.stride,
  targetSec = CARD_DEFAULTS.targetSec, maxCommits = CARD_DEFAULTS.maxCommits, slack = CARD_DEFAULTS.slack, graceMs = CARD_DEFAULTS.graceMs, opens = CARD_DEFAULTS.opens,
  prepareTimeoutMs = CARD_DEFAULTS.prepareTimeoutMs, timeoutMs = CARD_DEFAULTS.timeoutMs, enforce = true, now = Date.now, random = randomBytes}) {
  need(HEX32.test(String(host)) && typeof recover === 'function' && validShape({k, batch, stride, rounds: stride}), 'card check: host id, signature recovery and a shape');
  const roundGmac = batch * k * k / 1e9, commitsMax = Math.max(1, Math.min(maxCommits, CARD_LIMITS.commits, Math.floor(CARD_LIMITS.traceBytes / (batch * k))));
  return async function cardCheck(target, row, {epoch, seed, claim}) {
    const out = (ok, why, evidence) => ({name: CARD_CHECK, ok: ok === false && !enforce ? null : ok, why: (ok === false && !enforce ? 'recorded, not enforced: ' : '') + String(why).slice(0, 240), ...(evidence ? {evidence} : {})});
    const sold = (claim?.cards || []).filter(c => c.gmacPerSec > 0);
    if (!sold.length) return out(null, 'the host advertises no card with a rate');
    // which card: by the seed and the checker, as the app is chosen
    const card = [...sold].sort((a, b) => (sha(hex(seed), hex(host), u32(a.id)).toString('hex') < sha(hex(seed), hex(host), u32(b.id)).toString('hex') ? -1 : 1))[0];
    const rate = card.gmacPerSec * card.share;
    if (!(rate > 0)) return out(null, `card ${card.id}: none of it is advertised as free now`);
    const commits = Math.max(1, Math.min(commitsMax, Math.ceil(rate * targetSec / roundGmac / stride))), rounds = commits * stride;
    const gmac = rounds * roundGmac, allowMs = Math.min(timeoutMs, Math.ceil(slack * gmac / rate * 1000 + graceMs));
    const asked = {epoch, card: card.id, k, batch, rounds, stride, gmac: +gmac.toFixed(6), advertised: {gmacPerSec: card.gmacPerSec, share: card.share}, allowMs,
      // what the clock holds the host to: this many products inside the allowance (see THE CLOCK above)
      enforcedGmacPerSec: +(gmac / allowMs * 1000).toPrecision(4)};
    const c = {phase: 'prepare', version: 2, epoch, checker: host, target, seed, nonce: '0x' + random(32).toString('hex'), card: card.id, k, batch, rounds, stride};
    c.signature = await sign(cardChallengeMessage(domain, c));
    const post = async (body, ms) => {
      const res = await fetch(String(row.endpoint).replace(/\/+$/, '') + CARD_CHECK_PATH, {method: 'POST', redirect: 'error', headers: {'content-type': 'application/json'},
        body: JSON.stringify(body), signal: AbortSignal.timeout(ms)});
      return {status: res.status, body: res.ok ? await res.json() : null};
    };
    const notNow = s => [409, 429, 503].includes(s);
    let r;
    try { r = await post(c, prepareTimeoutMs); } catch (e) { return out(false, `card ${card.id}: no answer to prepare (${String(e?.name === 'TimeoutError' ? 'deadline' : e?.message || e).slice(0, 80)})`, asked); }
    if (notNow(r.status)) return out(null, `card ${card.id}: the host answered ${r.status} to prepare`, asked);
    if (r.status === 501) return out(false, `card ${card.id}: advertised, and the host's worker cannot run the check (HTTP 501)`, asked);
    if (r.status !== 200 || r.body?.ready !== true) return out(false, `card ${card.id}: advertised, and the host does not answer for it (HTTP ${r.status})`, asked);
    const run = '0x' + random(32).toString('hex'), started = now();
    try { r = await post({phase: 'run', epoch, checker: host, nonce: c.nonce, run}, allowMs + 5000); }
    catch (e) { return out(false, `card ${card.id}: the run did not come back (${String(e?.name === 'TimeoutError' ? `nothing inside ${allowMs + 5000} ms` : e?.message || e).slice(0, 80)})`, asked); }
    const elapsedMs = now() - started, a = r.body, total = commits * batch;
    const measured = {...asked, elapsedMs, gmacPerSec: +(gmac / Math.max(1, elapsedMs) * 1000).toPrecision(4)};
    if (notNow(r.status)) return out(null, `card ${card.id}: the host answered ${r.status} to run`, asked);
    if (r.status !== 200 || !a || a.epoch !== epoch || a.checker !== host || a.target !== target || a.nonce !== c.nonce || a.run !== run || !HEX32.test(String(a.root)) ||
        typeof a.signature !== 'string') return out(false, `card ${card.id}: the answer is not for this run (HTTP ${r.status})`, measured);
    let signer = null; try { signer = await recover(cardAnswerMessage(domain, a), a.signature); } catch {}
    if (!signer || signer.toLowerCase() !== String(row.proofKey).toLowerCase()) return out(false, `card ${card.id}: the answer is not signed by the host's proof key`, measured);
    if (elapsedMs > allowMs) return out(false, `card ${card.id}: ${gmac.toFixed(1)} G products took ${elapsedMs} ms, ${measured.gmacPerSec} G/s where ${rate.toFixed(2)} G/s is advertised as free`, measured);
    // only now, with the root held: which stretches to see
    const pick = new Set(); const count = Math.min(opens, total, CARD_LIMITS.opens);
    while (pick.size < count) pick.add(random(4).readUInt32LE() % total);
    const stretches = [...pick];
    try { r = await post({phase: 'open', epoch, checker: host, nonce: c.nonce, stretches}, timeoutMs); }
    catch (e) { return out(false, `card ${card.id}: the work was not shown (${String(e?.message || e).slice(0, 80)})`, measured); }
    const shown = r.status === 200 && Array.isArray(r.body?.stretches) && r.body.stretches.length === stretches.length ? r.body.stretches : null;
    if (!shown) return out(false, `card ${card.id}: the work was not shown (HTTP ${r.status})`, measured);
    // the verifier's own preparation, after the clock has stopped: the matrix and its Freivalds vectors
    const verifier = new CardVerifier(cardWeights(weightSeed(c), k, k), k, k), root = hex(a.root), b64 = v => Buffer.from(typeof v === 'string' ? v : '', 'base64');
    for (let i = 0; i < stretches.length; i++) {
      const at = Math.floor(stretches[i] / batch), rw = stretches[i] % batch, what = `stretch ${at} of row ${rw}`;
      const x = b64(shown[i].x), ys = b64(shown[i].ys), pad = cardPad(run, rw, k);
      if (x.length !== k || ys.length !== stride * k * 4) return out(false, `card ${card.id}: ${what} was not shown whole`, measured);
      // where it starts: the seed's row, or the state committed before it
      const from = at ? merkleRoot(sha(x), stretches[i] - batch, total, b64(shown[i].before)) : null;
      if (at ? !from || !from.equals(root) : !x.equals(bytesOf(cardVector(run, rw, k)))) return out(false, `card ${card.id}: ${what} does not start at the state it committed to`, measured);
      let cur = new Int8Array(x.buffer, x.byteOffset, k);
      for (let j = 0; j < stride; j++) {
        const y = ys.subarray(j * k * 4, (j + 1) * k * 4);
        if (!verifier.check(cur, y)) return out(false, `card ${card.id}: ${what}, step ${j}: the row is not the product`, measured);
        cur = chainStep(y, pad, k);
      }
      const to = merkleRoot(sha(bytesOf(cur)), stretches[i], total, b64(shown[i].after));
      if (!to || !to.equals(root)) return out(false, `card ${card.id}: ${what} does not end at the state it committed to`, measured);
    }
    return out(true, `card ${card.id}: ${gmac.toFixed(1)} G products in ${elapsedMs} ms, ${stretches.length} stretches of ${stride} checked`, {...measured, opened: stretches.length, root: a.root, signature: a.signature});
  };
}
