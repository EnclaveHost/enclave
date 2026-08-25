// shielded.mjs — the CVM's client for an untrusted GPU on the metal host.
//
// Runs INSIDE the measured SEV-SNP guest. Its counterpart is shielded/worker.py,
// which runs on the host, holds the card, and is assumed hostile: it sees public
// weights and one-time-padded activations, and nothing else, ever.
//
// WHY THE WORKER'S ADDRESS NEEDS NO ATTESTATION
// ---------------------------------------------
// The endpoint arrives over fw_cfg, which the host controls and the launch
// measurement does not cover. That is not a gap. A malicious host can point this
// at any worker it likes, including one it wrote itself, and gains nothing: the
// activation is masked with a pad the worker never receives, and every product is
// checked by Freivalds before it is used. The worst a substituted worker can do is
// refuse to answer, which is denial of service, and denial of service is the one
// thing the design explicitly does not promise to prevent. So the GPU's address is
// ordinary configuration, not a trust anchor -- which is exactly why the GPU can
// sit outside the enclave at all.
//
// SCOPE. This is the reference client and the box's proof-of-life for the shielded
// path: it establishes that a real masked field GEMM executes on the host's card
// and returns an exactly recoverable product, from inside the CVM, over the same
// 10.0.2.2 slirp link the egress helper already uses. Production inference does
// not run through here -- it runs through the ELL engine's shielded ggml backend
// (docs/shielded-inference.md, "Repo integration"), which is C++ inside wasmtime.
// The two must agree bit-for-bit, and `encodeWeightFixed` below is where that
// agreement is pinned: it mirrors shielded/kernels/fused_field_gemm.py operation
// for operation, in float32, because the TEE's u = r*W and the GPU's (x+r)*W must
// derive identical field elements or the subtraction returns noise.

import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';

// --- the shared field. These five constants are a contract with the kernel. ---
export const Q = [251, 241, 239];
export const M_MOD = Q[0] * Q[1] * Q[2];        // 14457349, ~2^23.8
export const HALF_M = Math.floor(M_MOD / 2);
export const QK = 32;                            // q8_0 block
export const FRAC = 8;
export const WEIGHT_BYTE_LIMIT = 119;            // == min(q)/2, hence the residue identity

const INV_Q0_MOD_Q1 = modInv(Q[0] % Q[1], Q[1]);
const INV_Q0Q1_MOD_Q2 = modInv((Q[0] * Q[1]) % Q[2], Q[2]);

function modInv(a, m) { for (let i = 1; i < m; i++) if ((a * i) % m === 1) return i; throw new Error('no inverse'); }
const mod = (a, m) => ((a % m) + m) % m;
const bal = (a, m = M_MOD) => { const v = mod(a, m); return v > Math.floor(m / 2) ? v - m : v; };

// --- protocol (mirrors shielded/protocol.py) ---------------------------------
export const CMD = {
  HELLO: 0, ALLOC_BUFFER: 1, FREE_BUFFER: 2, BUFFER_GET_BASE: 3, GET_ALIGNMENT: 4,
  GET_MAX_SIZE: 5, GET_DEVICE_MEMORY: 6, DEVICE_COUNT: 7, SET_TENSOR: 8,
  GET_TENSOR: 9, GRAPH_INSTALL: 10, GRAPH_RECOMPUTE: 11,
};

function frame(cmd, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(9);
  h[0] = cmd;
  h.writeBigUInt64LE(BigInt(payload.length), 1);
  return Buffer.concat([h, payload]);
}

/** One connection to a shielded worker. */
export class ShieldedLink {
  constructor(host, port, { timeoutMs = 60000 } = {}) {
    this.host = host; this.port = port; this.timeoutMs = timeoutMs;
    this.sock = null; this.buf = Buffer.alloc(0); this.waiters = [];
    this.bytesOut = 0; this.bytesIn = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port }, () => {
        s.setNoDelay(true);          // see wire.py: Nagle + a pipelined read deadlocks
        resolve();
      });
      s.setTimeout(this.timeoutMs, () => s.destroy(new Error('shielded worker timeout')));
      s.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._drain(); });
      s.on('error', (e) => { const w = this.waiters.splice(0); w.forEach(({ reject: r }) => r(e)); reject(e); });
      s.on('close', () => { const w = this.waiters.splice(0); w.forEach(({ reject: r }) => r(new Error('worker closed'))); });
      this.sock = s;
    });
  }

  _drain() {
    for (;;) {
      if (this.buf.length < 9 || !this.waiters.length) return;
      const size = Number(this.buf.readBigUInt64LE(1));
      if (this.buf.length < 9 + size) return;
      const status = this.buf[0];
      const payload = this.buf.subarray(9, 9 + size);
      this.buf = this.buf.subarray(9 + size);
      this.bytesIn += 9 + size;
      const { resolve, reject } = this.waiters.shift();
      // status 1 is a protocol violation and is always the last frame on the
      // connection; the worker closes right after sending it.
      if (status !== 0) reject(new Error(`worker refused: ${payload.toString('utf8')}`));
      else resolve(Buffer.from(payload));
    }
  }

  /** Write several request frames in ONE write, then collect their responses. */
  exchange(frames) {
    const promises = frames.map(() => new Promise((resolve, reject) => this.waiters.push({ resolve, reject })));
    const blob = Buffer.concat(frames);
    this.bytesOut += blob.length;
    this.sock.write(blob);
    return Promise.all(promises);
  }

  call(cmd, payload) { return this.exchange([frame(cmd, payload)]).then((r) => r[0]); }
  close() { try { this.sock?.destroy(); } catch {} }
}

// --- payload codecs -----------------------------------------------------------
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; };
export const packAlloc = (size, role) => Buffer.concat([u64(size), u32(role.length), Buffer.from(role, 'ascii')]);
export const packRegion = (bid, off, n) => Buffer.concat([u64(bid), u64(off), u64(n)]);
export const packSet = (bid, off, data) => Buffer.concat([u64(bid), u64(off), u64(data.length), data]);
export const packRecompute = (node, m) => Buffer.concat([u32(node), u32(m)]);

// --- fp16 -> fp32, so the guest reads the same block scales the kernel does ----
export function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -24) * f;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 25) * (1024 + f);
}
export function floatToHalf(v) {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, v);
  const x = buf.getUint32(0), sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15, man = (x >>> 13) & 0x3ff;
  if (exp <= 0) {                       // subnormal: real weights hit this, see PublicWeight
    const shift = 1 - exp;
    if (shift > 24) return sign;
    man = ((x & 0x7fffff) | 0x800000) >>> (13 + shift);
    return sign | man;
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | man;
}

/**
 * THE shared weight encoding. Mirrors fused_field_gemm.encode_weight_fixed
 * operation for operation, in float32 (Math.fround), because the TEE and the GPU
 * must derive bit-identical field elements from the same q8_0 bytes.
 */
export function encodeWeightFixed(dHalf, q) {
  const d256 = Math.fround(Math.fround(halfToFloat(dHalf)) * 256.0);
  return Math.floor(Math.fround(Math.fround(d256 * q) + 0.5));
}

// --- one-time pads ------------------------------------------------------------
/**
 * SHAKE-256 keyed stream. The invariant that matters: an index is issued exactly
 * once, ever, and exhaustion STALLS rather than wrapping. Two activations under
 * one pad hand the adversary their difference.
 */
export class MaskBank {
  constructor(seed = randomBytes(32), capacity = Number.MAX_SAFE_INTEGER) {
    this.seed = seed; this.capacity = capacity; this.counter = 0; this.issuedHi = -1;
  }

  issue(count) {
    if (this.counter >= this.capacity) throw new Error('mask bank exhausted; stall the request');
    const index = this.counter++;
    if (index <= this.issuedHi) throw new Error('mask index went backwards -- pad reuse');
    this.issuedHi = index;
    const idx = Buffer.alloc(8); idx.writeBigUInt64LE(BigInt(index), 0);
    const bytes = createHash('shake256', { outputLength: count * 8 })
      .update(Buffer.concat([this.seed, idx])).digest();
    const r = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      // Draw 48 bits and reduce: the bias against M is ~2^-24 rather than the
      // ~2^-8 a 32-bit draw would carry, and 48 bits stays exact in a double.
      const lo = bytes.readUInt32LE(i * 8), hi = bytes.readUInt16LE(i * 8 + 4);
      r[i] = (hi * 4294967296 + lo) % M_MOD;
    }
    return { index, r };
  }
}

// --- the online path ----------------------------------------------------------
export function toResidues(masked, K) {
  const planes = [new Int8Array(K), new Int8Array(K), new Int8Array(K)];
  for (let p = 0; p < 3; p++) {
    const q = Q[p], half = q >> 1;
    for (let i = 0; i < K; i++) { const v = masked[i] % q; planes[p][i] = v > half ? v - q : v; }
  }
  return planes;
}

export function crt(r0, r1, r2, N) {
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let x = mod(r0[i], Q[0]);
    const t1 = mod((mod(r1[i], Q[1]) - x) * INV_Q0_MOD_Q1, Q[1]);
    x += Q[0] * t1;
    const t2 = mod((mod(r2[i], Q[2]) - x) * INV_Q0Q1_MOD_Q2, Q[2]);
    x += Q[0] * Q[1] * t2;
    out[i] = x > HALF_M ? x - M_MOD : x;
  }
  return out;
}

/**
 * u = r*W over Z_M. The one term that can never be offloaded: a GPU computing it
 * learns the pad and can strip the mask.
 *
 * Accumulated in doubles without periodic reduction, and that is safe by
 * arithmetic rather than by hope: |r| < 2^24 and |w| <= 119 put each product under
 * 2^31, so K terms stay under 2^31 * K, which for any K a transformer uses is far
 * below the 2^53 a double holds exactly.
 */
export function refill(r, wFixed, K, N) {
  const u = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    let acc = 0;
    for (let k = 0; k < K; k++) acc += r[k] * wFixed[k * N + j];
    u[j] = bal(acc % M_MOD);
  }
  return u;
}

/** Uniform [0,1) from the OS CSPRNG -- the default source for the Freivalds secret. */
function secureUnitRandom() {
  // 53 bits, the mantissa a double carries exactly, so the draw is uniform
  // rather than quantised the way a 32-bit source would be. Take the TOP 53 of
  // 64 random bits and scale: 2^53 is exact in a double, so the quotient is too.
  const bits = randomBytes(8).readBigUInt64BE() >> 11n;
  return Number(bits) / 2 ** 53;
}

/**
 * Preprocessed Freivalds over an UNRELATED prime, so one check catches both a
 * lying worker and a field wrap. See shielded/tee.py Freivalds for the argument:
 * y_hat - y is always a multiple of M, so testing the identity mod P2 detects it.
 */
export class Freivalds {
  static P2 = 2147483647;
  static S_RANGE = 1 << 20;
  static REPS = 2;

  // s is the ONE value a lying worker must never predict: knowing it, the worker
  // solves d.s == 0 (mod P2) over any three outputs and returns y + d, which
  // check() accepts while the value decodes to garbage. Math.random is not a
  // CSPRNG and was the wrong default -- a caller that forgot the argument got a
  // forgeable secret with no error anywhere. Callers that need reproducibility
  // (the boot probe's fixture) pass their own generator explicitly.
  constructor(wFixed, K, N, rnd = secureUnitRandom) {
    this.K = K; this.N = N;
    this.s = [];
    this.sTilde = [];
    for (let rep = 0; rep < Freivalds.REPS; rep++) {
      const s = new Float64Array(N);
      for (let j = 0; j < N; j++) s[j] = 1 + Math.floor(rnd() * (Freivalds.S_RANGE - 1));
      const st = new Float64Array(K);
      for (let k = 0; k < K; k++) {
        let acc = 0;
        for (let j = 0; j < N; j++) acc += wFixed[k * N + j] * s[j];
        st[k] = mod(acc, Freivalds.P2);
      }
      this.s.push(s); this.sTilde.push(st);
    }
  }

  check(x, y) {
    const P2 = Freivalds.P2;
    for (let rep = 0; rep < Freivalds.REPS; rep++) {
      let lhs = 0;
      for (let j = 0; j < this.N; j++) lhs = (lhs + y[j] * this.s[rep][j]) % P2;
      let rhs = 0;
      // Reduce every term: |x| < 2^24 and |sTilde| < 2^31 make a single product
      // 2^55, which a double still holds exactly, but a running sum would not.
      for (let k = 0; k < this.K; k++) rhs = (rhs + (x[k] % P2) * this.sTilde[rep][k]) % P2;
      if (mod(lhs, P2) !== mod(rhs, P2)) return false;
    }
    return true;
  }
}
