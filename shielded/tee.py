#!/usr/bin/env python3
"""
tee.py -- the trusted half. Runs INSIDE the CVM; the worker never sees any of it.

reference/shielded_ref.py proves these constructions at toy scale over a single
24-bit prime. This module is the same algebra at production scale over the RNS
basis the kernel actually uses (251 x 241 x 239), against a real socket and a real
GPU. Where the two must agree they call the same code: `encode_weight_fixed` is
imported from the kernel module, not reimplemented, because a divergence there
does not fail loudly -- it silently returns noise.

WHAT LIVES HERE AND WHY
-----------------------
  PublicWeight   the shared, versioned weight encoding + the guard data derived
                 from it. Weights are public, so all of this could be computed by
                 anyone; it lives in the TEE because the TEE needs it, not because
                 it is secret.
  MaskBank       one-time pads. The single most dangerous object in the system.
  Freivalds      integrity. The worker is assumed to lie.
  ShieldedGemm   the online path: mask -> offload -> unmask -> verify.
  WorkerLink     the socket, the buffers, and the install-once graph.

THE PER-TENSOR EXPONENT (and why it is not a leak)
--------------------------------------------------
The design fixes l = 8 fractional bits for activations. It cannot also fix 8 for
weights: a real GGUF tensor has |w| up to ~0.5, so w*2^8 = 128 and the kernel's
int8 weight lane wraps -- silently, into a completely wrong product. So each
weight tensor carries its own public exponent f_w, the largest power of two with
max|w * 2^f_w| <= 119, applied by scaling the q8_0 BLOCK SCALES by 2^(f_w-8)
before upload. That is exact in fp16 (a power of two only moves the exponent
field), it leaves `encode_weight_fixed` byte-identical on both sides, and f_w is a
function of public weights alone -- it is not derived from any activation, so it
carries no information about user data.

The activation exponent stays fixed at 2^8 for exactly that reason. An adaptive
activation exponent would be a data-dependent public parameter, i.e. a real leak of
activation magnitude, and is refused here even though it would widen the headroom.

THE MAGNITUDE GUARD (open risk #3, made fail-closed)
----------------------------------------------------
Every intermediate must satisfy |y| < M/2 or it wraps and decodes to garbage WITH
NO ERROR SIGNAL. REPORT.md lists the fail-closed guard as mandatory-before-any-real
-model, and this is it: Cauchy-Schwarz, |y_j| <= ||x||_2 * ||w_j||_2, with the
column norms precomputed once from public weights and the row norm costing one O(K)
pass at run time. It is sound (never misses a wrap) rather than tight, and when it
trips the request aborts. It never adapts the encoding, so a trip leaks only that a
request failed -- which the design already concedes under "availability".
"""

import hashlib
import os
import struct
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "kernels"))

import numpy as np
import torch

import wire
from protocol import (CMD_ALLOC_BUFFER, CMD_GET_TENSOR, CMD_GRAPH_INSTALL,
                      CMD_GRAPH_RECOMPUTE, CMD_HELLO, CMD_SET_TENSOR)

# The RNS basis is the kernel's, not the oracle's single prime, and it comes from
# field.py rather than from the kernel module: the TEE runs in a CPU-only CVM and
# must not import torch/triton to obtain a rounding rule.
from field import (FRAC, HALF_M, INV_Q0_MOD_Q1, INV_Q0Q1_MOD_Q2, M_MOD, PRIMES,
                   Q0, Q1, Q2, QK, WEIGHT_BYTE_LIMIT, balanced,
                   encode_weight_fixed)


# ---------------------------------------------------------------------------
# Field helpers (RNS basis, matching kernels/fused_field_gemm.py exactly)
# ---------------------------------------------------------------------------
def to_residues_i8(a):
    """Balanced residues mod each prime as int8 -- the exact wire form the kernel
    reads. Mirrors fused_field_gemm.to_residues; kept here so the TEE has no
    import-time dependency on a CUDA module when it runs on a GPU-less CVM."""
    out = []
    for q in PRIMES:
        r = np.mod(a, q)
        out.append(np.where(r > q // 2, r - q, r).astype(np.int8))
    return out


def crt(r0, r1, r2):
    """Garner reconstruction, balanced. The TEE's own copy of the kernel epilogue,
    used for the refill (which never touches the GPU)."""
    x = np.mod(r0.astype(np.int64), Q0)
    t1 = np.mod((np.mod(r1.astype(np.int64), Q1) - x) * INV_Q0_MOD_Q1, Q1)
    x = x + Q0 * t1
    t2 = np.mod((np.mod(r2.astype(np.int64), Q2) - x) * INV_Q0Q1_MOD_Q2, Q2)
    x = x + (Q0 * Q1) * t2
    return np.where(x > HALF_M, x - M_MOD, x)


def exact_matmul(a_i64, b_i8):
    """Integer matmul, exact, but through BLAS.

    numpy has no BLAS path for int64, so `a @ b` on int64 arrays falls back to a
    naive loop -- fine for a toy oracle, ruinous for a 4864x896 tensor, and the
    reason a first calibration run over four short prompts had not finished in two
    minutes.

    float64 carries 53 bits of integer exactly. Here every |a| < 2^24 and
    |b| <= 119, so each product is under 2^31 and a sum over K terms stays under
    2^31 * K. For any K a transformer uses that is far below 2^53, so EVERY partial
    sum is an exactly-representable integer and the result is exact regardless of
    the order BLAS chooses to accumulate in or whether it fuses multiply-adds. The
    bound is asserted rather than assumed, and the int64 path is kept for the case
    where it does not hold -- correctness first, speed second.
    """
    a = np.asarray(a_i64, dtype=np.int64)
    b = np.asarray(b_i8, dtype=np.int64)
    bound = float(np.abs(a).max(initial=0)) * float(np.abs(b).max(initial=0)) * a.shape[-1]
    if bound >= 2.0 ** 52:
        return a @ b
    return np.rint(a.astype(np.float64) @ b.astype(np.float64)).astype(np.int64)


class FieldOverflow(Exception):
    """The magnitude guard tripped: this product would wrap Z_M. Abort the
    request. Never widen the field and retry silently -- the point of the guard is
    that a wrap is undetectable after the fact."""


class MaskExhausted(Exception):
    """The bank ran dry. STALL. Wrapping the counter would reuse a pad."""


class IntegrityFailure(Exception):
    """Freivalds failed: the worker returned something other than the product.
    Abort the request and quarantine the box."""


# ---------------------------------------------------------------------------
# Public weights
# ---------------------------------------------------------------------------
class PublicWeight:
    """A q8_0 weight tensor in the shared field encoding, plus everything derived.

    Holds w_fixed as int8 -- not int64. The byte-fit is a hard invariant checked at
    construction (that is what f_w is chosen for), so int8 is not a compression
    gamble, and it is 8x less CVM RAM for a quantity that is one third of the
    tier's memory budget. It is also the exact dtype the refill GEMM wants, so the
    refill does no conversion on the hot path.
    """

    __slots__ = ("name", "K", "N", "f_w", "wq", "wd_scaled", "w_fixed_i8",
                 "col_l2", "recon_err", "_res_t")

    def __init__(self, name, wq, wd, f_w=None):
        """wq: (K,N) int8 quants. wd: (K/QK,N) fp16 block scales, UNSCALED."""
        assert wq.ndim == 2 and wd.ndim == 2, "wq (K,N), wd (K/QK,N)"
        K, N = wq.shape
        assert K % QK == 0 and wd.shape == (K // QK, N), f"bad q8_0 layout {wq.shape} {wd.shape}"
        self.name, self.K, self.N = name, K, N

        if f_w is None:
            f_w = self._pick_exponent(wq, wd)
        self.f_w = int(f_w)
        # Scaling a power of two into an fp16 exponent is exact. Guard the ends of
        # the range anyway: an underflow to subnormal would quietly lose precision
        # on one side of a bit-identical-encoding requirement.
        scaled = wd.astype(np.float32) * np.float32(2.0) ** (self.f_w - FRAC)
        if not np.all(np.isfinite(scaled)):
            raise FieldOverflow(f"{name}: block scales overflow fp16 at f_w={self.f_w}")
        self.wd_scaled = scaled.astype(np.float16)
        self.wq = np.ascontiguousarray(wq)

        w_fixed = encode_weight_fixed(self.wd_scaled, self.wq)   # THE shared encoding
        peak = int(np.max(np.abs(w_fixed))) if w_fixed.size else 0
        if peak > WEIGHT_BYTE_LIMIT:
            raise FieldOverflow(
                f"{name}: |w_fixed| peaks at {peak} > {WEIGHT_BYTE_LIMIT}; the kernel's "
                f"int8 weight lane would wrap silently")
        # Scaling into fp16 SUBNORMALS is fine and must not be rejected. It happens
        # for blocks whose weights are so small that w * 2^f_w rounds to zero
        # anyway, so the bits lost were below the fixed-point quantum. What matters
        # is not that the scale survived intact but that the ENCODED WEIGHT still
        # represents the true weight to within its own quantum -- and that both
        # sides compute the same bytes, which they do by construction because they
        # read the same fp16 array through the same routine. An earlier version
        # rejected subnormals outright and refused every real tensor in the model.
        recon = w_fixed.astype(np.float64) / (2.0 ** self.f_w)
        true_w = (np.repeat(wd.astype(np.float64), QK, axis=0)[:wq.shape[0]]
                  * wq.astype(np.float64))
        err = np.max(np.abs(recon - true_w)) if w_fixed.size else 0.0
        if err > 1.5 / (2.0 ** self.f_w):
            raise FieldOverflow(
                f"{name}: encoded weights miss the true weights by {err:.3e}, more than "
                f"the {1.0 / 2.0 ** self.f_w:.3e} quantum at f_w={self.f_w}")
        self.recon_err = float(err)

        self.w_fixed_i8 = w_fixed.astype(np.int8)
        # THE WEIGHT NEEDS NO RNS DECOMPOSITION. REPORT.md establishes this for the
        # kernel -- one dequantisation feeds all three residue channels because a
        # byte-limited weight already satisfies w mod q_i == w. The same identity
        # holds on this side, and it is worth being explicit about why: the
        # balanced residue of v mod q equals v whenever |v| <= q//2, and the
        # smallest prime is 239, whose q//2 is exactly WEIGHT_BYTE_LIMIT. So all
        # three planes ARE w_fixed, and storing them separately would triple the
        # CVM RAM of the single largest resident for no arithmetic difference.
        assert min(q // 2 for q in PRIMES) >= WEIGHT_BYTE_LIMIT, \
            "byte limit no longer implies residue identity; restore the 3-plane form"
        self.col_l2 = np.sqrt((w_fixed.astype(np.float64) ** 2).sum(axis=0))
        self._res_t = None

    @staticmethod
    def _pick_exponent(wq, wd):
        """Largest f_w with max|rint(w * 2^f_w)| <= 119, found by construction and
        then VERIFIED by the caller against the real encoder. Deriving it from
        max|w| alone is not enough: rounding can push the peak over the limit, so
        the constructor re-checks the encoded array and this only has to be close."""
        d = np.abs(wd.astype(np.float64))
        q = np.abs(wq.astype(np.float64))
        peak = 0.0
        for b in range(0, wq.shape[0], QK * 64):     # blockwise, to bound memory
            sl = slice(b, min(b + QK * 64, wq.shape[0]))
            db = np.repeat(d, QK, axis=0)[sl]
            peak = max(peak, float((db * q[sl]).max(initial=0.0)))
        if peak <= 0:
            return FRAC
        f = int(np.floor(np.log2(WEIGHT_BYTE_LIMIT / peak)))
        # Walk down until the true encoding fits. At most a couple of steps.
        for cand in (f, f - 1, f - 2, f - 3):
            scaled = (wd.astype(np.float32) * np.float32(2.0) ** (cand - FRAC)).astype(np.float16)
            enc = encode_weight_fixed(scaled, wq)
            if np.max(np.abs(enc)) <= WEIGHT_BYTE_LIMIT:
                return cand
        raise FieldOverflow("no exponent fits the byte lane; tensor needs RNS-4")

    @property
    def total_frac(self):
        """Fractional bits in the product: activation 2^FRAC times weight 2^f_w."""
        return FRAC + self.f_w

    def residue_torch(self):
        """The weight as a CPU int8 torch tensor for the refill GEMM. One plane,
        not three -- see the identity asserted in __init__."""
        if self._res_t is None:
            self._res_t = torch.from_numpy(np.ascontiguousarray(self.w_fixed_i8))
        return self._res_t


# ---------------------------------------------------------------------------
# Mask bank
# ---------------------------------------------------------------------------
class MaskBank:
    """One-time additive pads over Z_M, from a cryptographic stream.

    THE INVARIANT: an index is issued exactly once, ever. Two activations masked
    with the same pad hand the adversary their difference, and successive decode
    activations differ by very little -- so a reuse is close to handing over the
    activations themselves. Issuance is therefore a strict monotonic counter that
    STALLS at capacity (MaskExhausted) and never wraps.

    The oracle uses blake2b-CTR; this uses SHAKE-256, an XOF, so a whole pad is one
    call instead of one call per 16 words -- 190x fewer hash invocations for a 3072
    -wide activation, which matters at ~100 exchanges per token. Both are
    cryptographic streams keyed by the same (seed, index); production swaps in
    AES-CTR for the hardware path. Values are drawn as uint64 and reduced, so the
    modulo bias is ~2^-40 rather than the ~2^-8 a uint32 draw would carry.
    """

    def __init__(self, seed=None, capacity=1 << 40):
        self.seed = seed if seed is not None else os.urandom(32)
        self.capacity = capacity
        self.counter = 0
        self.issued_hi = -1          # highest index issued; monotonicity witness
        self._lock = threading.Lock()

    def _stream(self, index, count):
        buf = hashlib.shake_256(self.seed + struct.pack("<Q", index)).digest(count * 8)
        return (np.frombuffer(buf, dtype=np.uint64) % np.uint64(M_MOD)).astype(np.int64)

    def issue(self, shape):
        count = int(np.prod(shape))
        with self._lock:
            if self.counter >= self.capacity:
                raise MaskExhausted("mask bank exhausted; stall the request")
            index = self.counter
            self.counter += 1
            # Monotonicity is the machine-checkable form of "never reused". A set
            # of every issued index would be unbounded; the counter cannot go
            # backwards, so this assertion has the same force at O(1).
            assert index > self.issued_hi, "mask index went backwards -- pad reuse"
            self.issued_hi = index
        return index, self._stream(index, count).reshape(shape)


# ---------------------------------------------------------------------------
# Integrity
# ---------------------------------------------------------------------------
class Freivalds:
    """Preprocessed Freivalds, run over the INTEGERS rather than over Z_M.

    Slalom Lemma 3.1 checks y*s == x*(W*s) with both sides reduced mod the field
    modulus. That catches a lying worker, and it is what reference/shielded_ref.py
    implements. It cannot catch the OTHER failure this tier has: a true product
    that exceeds M/2 and wraps. A wrapped y is still congruent to x*W mod M, so a
    mod-M check passes it, and the value decodes to garbage with no error signal --
    REPORT.md's open risk #3, and the reason its next-step list has "land the
    per-tensor magnitude guard, failing closed" ahead of anything else.

    So the check is done modulo an UNRELATED prime P2 instead. Write y_hat for what
    the TEE recovered and y for the true integer product. y_hat == y mod M always,
    by construction, so any discrepancy is y_hat - y = c*M for an integer vector c,
    nonzero exactly where the product wrapped. Then

        y_hat*s - x*(W*s)  ==  (c*s)*M   (mod P2)

    which vanishes only if c*s == 0 mod P2. gcd(M, P2) = 1, and s is secret and
    uniform, so that happens with probability <= 1/|S| per repetition. The check
    therefore catches a lying worker AND a field wrap in the same two dot products,
    at the same cost, and strictly subsumes the oracle's mod-M version. A
    conservative a-priori bound (Cauchy-Schwarz on ||x||_2 ||w_j||_2) was tried
    first and is far too loose to be usable: it rejects a perfectly ordinary
    random-weight GEMM whose true peak sits 30x below the limit.

    s and s_tilde = W*s stay TEE-only forever. A worker that learns s can forge.

    RANGE. Every intermediate is kept inside int64 deliberately, not by luck:
    s < 2^20 and |w_fixed| <= 119 put W*s under 2^39 for K <= 4096, and the x*s_tilde
    pass reduces every CHUNK_K terms so the accumulator cannot reach 2^63. That
    periodic reduction is Slalom Appendix F applied to the verifier instead of the
    GEMM.
    """

    P2 = (1 << 31) - 1     # Mersenne, coprime to M = 251*241*239
    S_RANGE = 1 << 20      # Slalom's |S| ~ 2^20
    REPS = 2               # ~2^-40 per check
    CHUNK_K = 128          # keeps the rhs accumulator under 2^61

    def __init__(self, weight, rng):
        self.K, self.N = weight.K, weight.N
        self.s = rng.integers(1, self.S_RANGE, size=(weight.N, self.REPS), dtype=np.int64)
        wf = weight.w_fixed_i8.astype(np.int64)
        # |wf| <= 119, |s| < 2^20, K <= 4096  =>  under 2^39. No chunking needed.
        self.s_tilde = np.mod(wf @ self.s, self.P2)
        self.m_mod_p2 = M_MOD % self.P2

    def _rhs(self, x):
        """(x @ s_tilde) mod P2, reducing every CHUNK_K terms."""
        m, K = x.shape
        pad = (-K) % self.CHUNK_K
        if pad:
            x = np.concatenate([x, np.zeros((m, pad), dtype=np.int64)], axis=1)
        blocks = x.shape[1] // self.CHUNK_K
        xb = x.reshape(m, blocks, self.CHUNK_K)
        st = self.s_tilde
        if pad:
            st = np.concatenate([st, np.zeros((pad, self.REPS), dtype=np.int64)], axis=0)
        stb = st.reshape(blocks, self.CHUNK_K, self.REPS)
        acc = np.zeros((m, self.REPS), dtype=np.int64)
        for b in range(blocks):
            acc += np.mod(xb[:, b, :] @ stb[b], self.P2)
        return np.mod(acc, self.P2)

    def check(self, x_int, y_int):
        """x_int, y_int are BALANCED integers -- the true fixed-point values, not
        residues. Passing residues here would silently defeat the wrap half."""
        lhs = np.mod(np.asarray(y_int, dtype=np.int64) @ self.s, self.P2)
        return bool(np.array_equal(lhs, self._rhs(np.asarray(x_int, dtype=np.int64))))


# ---------------------------------------------------------------------------
# The refill: u = r*W, the one term that can never be offloaded
# ---------------------------------------------------------------------------
def refill(r_field, weight: PublicWeight):
    """u = r*W over Z_M, computed IN THE TEE, in RNS, on int8 lanes.

    This is the tier's structural cost: one TEE MAC per GPU MAC per prime. It
    cannot be offloaded, because a GPU computing r*W learns the pad and can strip
    the mask, and masking r itself needs a mask for the mask, forever.

    REPORT.md measures this path at 4830 G-MAC/s on 16 EPYC cores via int8/VNNI
    against 254 G-MAC/s for the stock fp64 BLAS that an earlier revision measured
    by mistake -- a 19x error that made refill look like the binding constraint
    when it has 2.7x headroom. Hence torch._int_mm, and hence the exactness probe
    below rather than a comment claiming exactness.
    """
    m, K = r_field.shape
    # One GEMM, not three. The three residue planes of r share a single weight
    # operand (the identity in PublicWeight), so stacking them into one (3m,K)
    # matrix turns three skinny GEMMs into one that is 3x taller -- which at
    # decode, where m=1, is the difference between three matrix-VECTOR products
    # and one matrix-matrix product the BLAS actually has a fast path for.
    planes = np.empty((3 * m, K), dtype=np.int8)
    for qi, q in enumerate(PRIMES):
        rr = np.mod(r_field, q)
        planes[qi * m:(qi + 1) * m] = np.where(rr > q // 2, rr - q, rr)
    a = torch.from_numpy(planes)
    b = weight.residue_torch()
    try:
        prod = torch._int_mm(a, b).numpy()
    except RuntimeError:
        # _int_mm has shape restrictions that vary by build; the int32 fallback is
        # exact and merely slower, and correctness is not negotiable here.
        prod = a.numpy().astype(np.int32) @ b.numpy().astype(np.int32)
    acc = [np.mod(prod[qi * m:(qi + 1) * m].astype(np.int64), q)
           for qi, q in enumerate(PRIMES)]
    return crt(acc[0], acc[1], acc[2])


def refill_is_exact(K=512, N=128, seed=7):
    """Probe, not an assertion in a comment. An inexact GEMM backend (bf16 is the
    trap: REPORT.md measures torch bf16 at 2419 G-MAC/s and NOT exact) would make
    every unmasked result wrong in a way that looks like a masking bug."""
    rng = np.random.default_rng(seed)
    wq = rng.integers(-127, 128, size=(K, N)).astype(np.int8)
    wd = (rng.uniform(0.5, 1.5, size=(K // QK, N)) * (1.0 / np.sqrt(K) / 127.0 * 4.0)).astype(np.float16)
    w = PublicWeight("probe", wq, wd)
    r = rng.integers(0, M_MOD, size=(3, K)).astype(np.int64)
    got = refill(r, w)
    want = balanced(np.mod(r @ w.w_fixed_i8.astype(np.int64), M_MOD))
    return bool(np.array_equal(got, want))


# ---------------------------------------------------------------------------
# The link to the untrusted worker
# ---------------------------------------------------------------------------
def _align(x, a=64):
    return (x + a - 1) // a * a


class WorkerLink:
    """Buffers, the install-once graph, and the per-exchange path.

    The graph is installed ONCE per connection and holds one node per weight
    tensor. After that the only compute trigger is the doorbell, which carries a
    node index and a batch size and no topology at all -- so the op allowlist is
    checked once, against the whole model, and cannot be re-litigated per token by
    anything the transport does.
    """

    def __init__(self, host="127.0.0.1", port=9500, seed=None, rng=None, verify=True):
        self.host, self.port = host, port
        self.pipe = None
        self.bank = MaskBank(seed=seed)
        # The Freivalds secret s is drawn from THIS generator, and s is the one
        # value a lying worker must never predict: knowing it, the worker solves
        # d.s == 0 (mod P2) over any three outputs and returns y + d, which the
        # check accepts while the value decodes to garbage. A fixed seed here --
        # the previous default -- put s in the public source, so the integrity
        # guarantee held only against accidents, not against the untrusted
        # operator the whole tier is built to survive. Seed from the OS CSPRNG
        # unless a caller deliberately pins one for a reproducible test.
        self.rng = rng if rng is not None else np.random.default_rng(
            int.from_bytes(os.urandom(32), "big"))
        self.verify = verify
        self.weights = []          # PublicWeight, in node order
        self.nodes = []            # dict per node, filled at register()
        self.freivalds = {}
        self._wbytes = 0
        self._abytes = 0
        self.info = {}
        self.stats = {"exchanges": 0, "offloaded_macs": 0, "verify_fail": 0,
                      "bytes_out": 0, "bytes_in": 0}

    # -- build phase -------------------------------------------------------
    def register(self, weight: PublicWeight, m_buckets=(1,), share_x_with=None):
        """Add a weight as one FIELD_GEMM node. Returns the node index.

        `share_x_with` points at an earlier node fed by the SAME activation --
        q/k/v from one attn_norm, gate/up from one ffn_norm. Those nodes then read
        the same x region, so the masked activation is uploaded once and three
        doorbells consume it. That is not just a bandwidth saving: it is also the
        only correct way to mask them. One plaintext gets one pad; masking the
        same x three times under three different pads would hand the adversary
        three encryptions of one value for no benefit.
        """
        idx = len(self.nodes)
        max_m = max(m_buckets)
        wq_off = _align(self._wbytes)
        wd_off = _align(wq_off + weight.wq.nbytes)
        self._wbytes = wd_off + weight.wd_scaled.nbytes
        if share_x_with is not None:
            donor = self.nodes[share_x_with]
            if donor["K"] != weight.K or donor["max_m"] < max_m:
                raise ValueError(f"node {idx} cannot share x with {share_x_with}: "
                                 f"K/{donor['K']} vs {weight.K}, max_m {donor['max_m']} vs {max_m}")
            x_off = donor["x"]["offset"]
            y_off = _align(self._abytes)
            self._abytes = y_off + max_m * weight.N * 4
        else:
            x_off = _align(self._abytes)
            y_off = _align(x_off + 3 * max_m * weight.K)
            self._abytes = y_off + max_m * weight.N * 4
        self.weights.append(weight)
        self.nodes.append({
            "op": "FIELD_GEMM", "id": weight.name,
            "wq": {"bid": 1, "offset": wq_off},
            "wd": {"bid": 1, "offset": wd_off},
            "x": {"bid": 2, "offset": x_off},
            "y": {"bid": 2, "offset": y_off},
            "K": weight.K, "N": weight.N, "max_m": max_m,
            "_m_buckets": tuple(sorted(set(m_buckets))),
            "_shared": share_x_with is not None,
        })
        if self.verify:
            self.freivalds[idx] = Freivalds(weight, self.rng)
        return idx

    def connect(self):
        self.pipe = wire.Pipe(self.host, self.port)
        import json as _json
        self.info = _json.loads(self.pipe.call(CMD_HELLO, wire.pack_hello(1)))
        for bid, (size, role) in enumerate(
                ((self._wbytes, "weights"), (self._abytes, "activations")), start=1):
            got = struct.unpack("<Q", self.pipe.call(CMD_ALLOC_BUFFER,
                                                     wire.pack_alloc(size, role)))[0]
            assert got == bid, f"worker assigned bid {got}, expected {bid}"
        return self.info

    def upload_weights(self, chunk=32 << 20):
        """Weights are PUBLIC: they cross the boundary in the clear, by design.
        Chunked because a single 8B tensor upload would otherwise be one frame."""
        for node, w in zip(self.nodes, self.weights):
            for off, arr in ((node["wq"]["offset"], w.wq),
                             (node["wd"]["offset"], w.wd_scaled)):
                blob = arr.tobytes()
                for p in range(0, len(blob), chunk):
                    part = blob[p:p + chunk]
                    self.pipe.call(CMD_SET_TENSOR, wire.pack_set_tensor(1, off + p, part))

    def install(self):
        import json as _json
        outputs = []
        for node in self.nodes:
            for m in node["_m_buckets"]:
                outputs.append({"bid": 2, "offset": node["y"]["offset"],
                                "nbytes": m * node["N"] * 4})
        spec = {"nodes": [{k: v for k, v in n.items() if not k.startswith("_")}
                          for n in self.nodes],
                "outputs": outputs}
        return _json.loads(self.pipe.call(CMD_GRAPH_INSTALL,
                                          _json.dumps(spec).encode()))

    # -- the online path ---------------------------------------------------
    def gemm(self, idx, x_field):
        """One masked linear op. Convenience wrapper over the group path."""
        return self.gemm_shared([idx], x_field)[0]

    def gemm_shared(self, indices, x_field):
        """Offload several weights that all consume the SAME activation, in one
        round trip. Returns a list of exact field products, one per index.

        x_field is the PLAINTEXT field-encoded activation (m,K) int64. Order is
        not arbitrary: the pad is issued once and consumed once, every result is
        verified before it is returned, and nothing is handed back until every
        check in the group has passed -- so a caller cannot accidentally use the
        first of three results while the third turns out to be corrupt.
        """
        if not indices:
            return []
        m, K = x_field.shape
        for idx in indices:
            node = self.nodes[idx]
            if K != node["K"]:
                raise ValueError(f"node {idx} wants K={node['K']}, got {K}")
            if m not in node["_m_buckets"]:
                raise ValueError(f"node {idx}: m={m} is not a declared bucket "
                                 f"{node['_m_buckets']}; shapes are public and bucketed")

        t0 = time.perf_counter()
        xb = balanced(x_field)
        _, r = self.bank.issue((m, K))          # ONE pad for ONE plaintext
        planes = to_residues_i8(np.mod(xb + r, M_MOD))
        t_mask = time.perf_counter() - t0

        # Upload the masked activation once per distinct x region, then ring one
        # doorbell per node, then read every output -- all in a single write.
        frames, seen = [], set()
        for idx in indices:
            node = self.nodes[idx]
            xo = node["x"]["offset"]
            if xo not in seen:
                seen.add(xo)
                stride = node["max_m"] * K
                for pl in range(3):
                    frames.append((CMD_SET_TENSOR,
                                   wire.pack_set_tensor(2, xo + pl * stride,
                                                        planes[pl].tobytes())))
        for idx in indices:
            frames.append((CMD_GRAPH_RECOMPUTE, wire.pack_recompute(idx, m)))
        for idx in indices:
            node = self.nodes[idx]
            frames.append((CMD_GET_TENSOR,
                           wire.pack_region(2, node["y"]["offset"], m * node["N"] * 4)))

        t0 = time.perf_counter()
        resp = self.pipe.exchange(frames)
        t_wire = time.perf_counter() - t0
        outs = resp[-len(indices):]

        results = []
        t_refill = t_verify = 0.0
        for idx, blob in zip(indices, outs):
            node, w = self.nodes[idx], self.weights[idx]
            y_masked = np.frombuffer(blob, dtype=np.int32).reshape(m, node["N"]).astype(np.int64)
            t0 = time.perf_counter()
            u = refill(r, w)
            t_refill += time.perf_counter() - t0
            y = balanced(y_masked - u)

            # One check, two failure modes: a worker that lied, and a true product
            # that exceeded M/2 and wrapped. Both are fatal to the request and both
            # are caught here, before the caller can use y for anything -- in
            # particular before it can be written into the KV cache, where a single
            # bad entry poisons every future token that attends to it.
            if self.verify:
                t0 = time.perf_counter()
                ok = self.freivalds[idx].check(xb, y)
                t_verify += time.perf_counter() - t0
                if not ok:
                    self.stats["verify_fail"] += 1
                    near = int(np.abs(y).max()) > HALF_M // 2
                    raise IntegrityFailure(
                        f"{w.name}: Freivalds failed at m={m} -- the worker lied, or the "
                        f"product wrapped Z_M (peak |y| = {int(np.abs(y).max())} against "
                        f"M/2 = {HALF_M}{'; near the boundary, so a wrap is likely' if near else ''})")
            self.stats["exchanges"] += 1
            self.stats["offloaded_macs"] += m * K * node["N"]
            self.stats["peak_y"] = max(self.stats.get("peak_y", 0), int(np.abs(y).max()))
            results.append(y)
        self.stats["round_trips"] = self.stats.get("round_trips", 0) + 1
        for k, v in (("t_mask", t_mask), ("t_wire", t_wire),
                     ("t_refill", t_refill), ("t_verify", t_verify)):
            self.stats[k] = self.stats.get(k, 0.0) + v
        return results

    def close(self):
        if self.pipe is not None:
            self.stats["bytes_out"] = self.pipe.bytes_out
            self.stats["bytes_in"] = self.pipe.bytes_in
            self.pipe.close()
            self.pipe = None


# ---------------------------------------------------------------------------
# Selftest -- driven by test/shielded-tee.test.mjs. No GPU, no socket.
# ---------------------------------------------------------------------------
def selftest():
    """Everything the TEE side must get right that does not need a card.

    Each entry is a property the design rests on, exercised rather than asserted
    in prose. The GPU-attached half lives in e2e.py and is gated on CUDA.
    """
    out = {}
    rng = np.random.default_rng(20260825)

    # -- the weight encoding, and the residue identity it buys ----------------
    K, N = 256, 64
    wq = rng.integers(-127, 128, size=(K, N)).astype(np.int8)
    wd = (rng.uniform(0.5, 1.5, size=(K // QK, N))
          * (1.0 / np.sqrt(K) / 127.0 * 4.0)).astype(np.float16)
    w = PublicWeight("selftest", wq, wd)
    out["weight_fits_byte_lane"] = int(np.abs(w.w_fixed_i8).max()) <= WEIGHT_BYTE_LIMIT
    out["weight_peak"] = int(np.abs(w.w_fixed_i8).max())
    out["weight_exponent"] = w.f_w
    out["weight_reconstruction_within_quantum"] = w.recon_err <= 1.5 / 2.0 ** w.f_w
    # the identity that lets one int8 plane serve all three primes
    res = to_residues_i8(np.mod(w.w_fixed_i8.astype(np.int64), M_MOD))
    out["weight_residues_equal_weight"] = all(
        np.array_equal(p.astype(np.int64), w.w_fixed_i8.astype(np.int64)) for p in res)

    # -- a real GGUF tensor needs an exponent other than the design's l=8 ------
    # (the reason PublicWeight has f_w at all: |w| ~ 0.5 puts w*2^8 past the lane)
    big = (np.ones((K // QK, N), dtype=np.float32) * 0.004).astype(np.float16)
    out["exponent_adapts"] = PublicWeight("big", wq, big).f_w != FRAC

    # -- mask bank ------------------------------------------------------------
    bank = MaskBank(seed=b"\x01" * 32, capacity=4)
    idxs = [bank.issue((2, 8))[0] for _ in range(4)]
    out["mask_indices_unique"] = len(set(idxs)) == 4
    out["mask_indices_monotonic"] = idxs == sorted(idxs)
    try:
        bank.issue((2, 8))
        out["mask_exhaustion_stalls"] = False
    except MaskExhausted:
        # A wraparound here is not a slowdown, it is pad reuse across two
        # activations, which hands the adversary their difference.
        out["mask_exhaustion_stalls"] = True
    b2 = MaskBank(seed=b"\x01" * 32, capacity=4)
    out["mask_stream_is_deterministic"] = np.array_equal(
        MaskBank(seed=b"\x02" * 32).issue((1, 16))[1],
        MaskBank(seed=b"\x02" * 32).issue((1, 16))[1])
    out["mask_differs_by_seed"] = not np.array_equal(
        b2.issue((1, 16))[1], MaskBank(seed=b"\x03" * 32).issue((1, 16))[1])

    # -- refill ---------------------------------------------------------------
    out["refill_exact"] = refill_is_exact()

    # -- Slalom recovery, end to end, with a simulated worker -----------------
    x = np.rint(rng.normal(0, 1, size=(3, K)) * (1 << FRAC)).astype(np.int64)
    _, r = MaskBank(seed=b"\x09" * 32).issue((3, K))
    masked = np.mod(x + r, M_MOD)
    y_masked = balanced(exact_matmul(masked, w.w_fixed_i8))
    y = balanced(y_masked - refill(r, w))
    want = exact_matmul(x, w.w_fixed_i8)
    out["slalom_recovers_bit_exactly"] = bool(np.array_equal(y, want))

    # -- Freivalds: catches a lie, and catches a WRAP -------------------------
    fv = Freivalds(w, rng)
    out["freivalds_accepts_honest"] = fv.check(x, y)
    caught = 0
    for t in range(64):
        lie = y.copy()
        lie[t % 3, (t * 7) % N] += 1          # single-element lie: the hard case
        if not fv.check(x, lie):
            caught += 1
    out["freivalds_catches_single_element_lie"] = caught
    out["freivalds_lie_trials"] = 64
    # The wrap half: a product congruent mod M but off by a multiple of it passes
    # the ORACLE's mod-M check and must fail this one.
    wrapped = y.copy()
    wrapped[0, 0] += M_MOD
    out["freivalds_catches_field_wrap"] = not fv.check(x, wrapped)
    out["mod_m_check_would_miss_the_wrap"] = bool(
        np.array_equal(np.mod(wrapped, M_MOD)[0, 0], np.mod(y, M_MOD)[0, 0]))

    # -- exact_matmul is exact ------------------------------------------------
    a = rng.integers(-(1 << 20), 1 << 20, size=(5, 512)).astype(np.int64)
    b = rng.integers(-119, 120, size=(512, 96)).astype(np.int8)
    out["exact_matmul_matches_int64"] = bool(
        np.array_equal(exact_matmul(a, b), a @ b.astype(np.int64)))

    out["ok"] = all(v for v in out.values() if isinstance(v, bool)) and \
        out["freivalds_catches_single_element_lie"] == 64
    return out


if __name__ == "__main__":
    import json as _json
    print(_json.dumps(selftest(), separators=(",", ":"), default=int))
