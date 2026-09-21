#!/usr/bin/env python3
"""
lpnpad.py -- LPN-structured one-time pads for masked linear offload. Reference.

THE PROBLEM THIS SOLVES
-----------------------
Slalom masking sends x + r to an untrusted GPU and recovers W.x as
W.(x + r) - W.r. The pad r costs nothing; W.r costs a full pass over the
weights, in the TEE, per (layer, token). On the CPUs a TEE actually has that
pass is memory-bound (shielded/REPORT.md section 3; bench/refill_bench.py).

THE CONSTRUCTION
----------------
    r = A.s + e            A: public n x k, fixed per width (from a public seed)
                           s: fresh, uniform in R^k, one per pad
                           e: fresh, t-sparse in R^n, nonzero entries are UNITS
    W.r = (W.A).s + W.e    W.A is m x k, precomputed once per layer
                           W.e is a sum of t columns of W

so u = W.r costs k.m + t.m multiplies (and reads k.m ring elements plus t
columns of W) instead of n.m. Security is the primal LPN / syndrome-decoding
assumption: r is pseudorandom, and because (s, e) are fresh per pad a host that
learns one pad exactly (its own prompt, layer 0) gets one syndrome-decoding
instance, not one equation of a growing linear system.

WHAT THIS FILE IS
-----------------
The executable reference: numpy only, deliberately unoptimised, every ring
operation exact. Three pad sources with one interface (uniform, LPN with
random noise positions, regular LPN with one noise position per block), two
rings (Z_2^b with wrapping arithmetic as the handoff specifies, and the tier's
own Z_M with M = 251.241.239 so exactness is proven in the ring the engine
runs), Freivalds over the integers, and a toy integer transformer whose masked
forward pass must equal its in-TEE forward pass bit for bit. test_lpnpad.py
asserts all of it; bench_pads.c is the fast path that mirrors these formulas.

TWO DETAILS THE HANDOFF DID NOT STATE, BOTH LOAD-BEARING
--------------------------------------------------------
1. Noise values must be UNITS of the ring (odd in Z_2^b; coprime to M in Z_M).
   Reducing r = A.s + e mod 2 turns a Z_2^b instance into an F_2 LPN instance
   whose noise is e mod 2. With arbitrary noise values half the noise vanishes
   mod 2 and the F_2 instance has weight ~t/2, i.e. the parameters buy half the
   security they were chosen for. With unit noise, e mod 2 has weight exactly
   t. (Once the F_2 instance is solved the full support is known and every
   higher bit falls to linear algebra on the noise-free coordinates, so the
   Z_2^b instance is AT MOST as hard as F_2-LPN(n, k, t). That direction is
   the one to size for; see lpn_select.py and REPORT.md open question 1.)
2. Computing r itself is not free: A.s is n.k multiplies, and a dense A stored
   at ring width is as many bytes as W.A. The handoff's byte accounting omits
   it. Three public-matrix layouts are implemented so the cost can be measured
   rather than argued: dense at ring width (the handoff's A), dense with byte
   entries, and Toeplitz (n + k - 1 ring elements, no bandwidth). All three
   reduce mod 2 to a uniform F_2 matrix; Toeplitz-LPN is a studied variant
   (HB#, Jain-Krenn-Pietrzak-Tentes) but a distinct assumption, and is flagged.

Conventions: the handoff's. W is m x n (m outputs, n inputs), x is a column,
y = W.x. A batch of B tokens is X of shape n x B. Ring elements are canonical
int64 in [0, modulus); the balanced form is used only for Freivalds and for
decoding a product back to a signed integer.
"""

import hashlib
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
try:
    from field import M_MOD as TIER_M            # 251 * 241 * 239, the engine's field
except ImportError:                              # standalone copy of this directory
    TIER_M = 251 * 241 * 239

FV_P2 = 2147483647                               # 2^31 - 1: the Freivalds prime, unrelated to any ring


# ---------------------------------------------------------------------------
# Rings
# ---------------------------------------------------------------------------
class Ring:
    """Exact arithmetic in Z_2^bits (wrapping) or Z_modulus (odd modulus).

    Every array this class hands out is canonical int64 in [0, modulus). The
    matmul is exact for any operand sizes a transformer has: products of two
    ring elements are < 2^64 and are accumulated in uint64, which wraps mod
    2^64 -- harmless for Z_2^b (2^b divides 2^64) and, for Z_M, avoided by
    reducing operands so every product is < 2^48 and chunking K at 2^15.
    """

    def __init__(self, bits=None, modulus=None):
        if (bits is None) == (modulus is None):
            raise ValueError("exactly one of bits / modulus")
        if bits is not None:
            if not 8 <= bits <= 32:
                raise ValueError("bits in [8, 32]")
            self.bits, self.modulus, self.power_of_two = bits, 1 << bits, True
            self.name = f"Z_2^{bits}"
        else:
            if modulus % 2 == 0 or modulus >= (1 << 32):
                raise ValueError("odd modulus below 2^32")
            self.bits, self.modulus, self.power_of_two = int(math.ceil(math.log2(modulus))), int(modulus), False
            self.name = f"Z_{modulus}"
        self.half = self.modulus // 2
        self.storage_bytes = (self.bits + 7) // 8   # what a ring element costs to store

    # -- representation ----------------------------------------------------
    def reduce(self, a):
        return np.mod(np.asarray(a, dtype=np.int64), self.modulus)

    def balanced(self, a):
        """Signed representative in (-modulus/2, modulus/2]."""
        a = self.reduce(a)
        return np.where(a > self.half, a - self.modulus, a)

    def lift(self, a):
        """Signed integers (weights, activations) -> ring elements."""
        return self.reduce(a)

    # -- arithmetic --------------------------------------------------------
    def add(self, a, b):
        return self.reduce(np.asarray(a, dtype=np.int64) + np.asarray(b, dtype=np.int64))

    def sub(self, a, b):
        return self.reduce(np.asarray(a, dtype=np.int64) - np.asarray(b, dtype=np.int64))

    def mul(self, a, b):
        a = np.asarray(a, dtype=np.uint64); b = np.asarray(b, dtype=np.uint64)
        if self.power_of_two:
            return self.reduce((a * b).astype(np.int64))          # wraps mod 2^64, then mod 2^b
        # both < 2^24 -> product < 2^48, exact in uint64
        return self.reduce((a * b).astype(np.int64))

    def matmul(self, A, B):
        """(A @ B) mod modulus, exact. A: (m, K), B: (K, ...) canonical."""
        A = np.asarray(A, dtype=np.uint64); B = np.asarray(B, dtype=np.uint64)
        if self.power_of_two:
            return self.reduce((A @ B).astype(np.int64))          # uint64 wraparound is mod 2^64
        # Z_M: products < 2^48; 2^15 of them sum below 2^63.
        K = A.shape[-1]
        out = np.zeros(A.shape[:-1] + B.shape[1:], dtype=np.int64)
        for k0 in range(0, K, 1 << 15):
            part = (A[..., k0:k0 + (1 << 15)] @ B[k0:k0 + (1 << 15)]).astype(np.int64)
            out = self.reduce(out + self.reduce(part))
        return out

    # -- sampling ----------------------------------------------------------
    def uniform(self, rng, shape):
        """Uniform ring elements. rng must be a CSPRNG-backed Generator in
        production (secrets -> default_rng(seed) is NOT that; see PadRNG)."""
        return rng.integers(0, self.modulus, size=shape, dtype=np.int64)

    def unit(self, rng, shape):
        """Uniform UNITS of the ring: odd for Z_2^b, coprime to M for Z_M.
        This is the noise-value distribution. See the module docstring."""
        if self.power_of_two:
            return (rng.integers(0, self.modulus // 2, size=shape, dtype=np.int64) << 1) | 1
        out = rng.integers(1, self.modulus, size=shape, dtype=np.int64)
        bad = np.gcd(out, self.modulus) != 1
        while bad.any():
            out[bad] = rng.integers(1, self.modulus, size=int(bad.sum()), dtype=np.int64)
            bad = np.gcd(out, self.modulus) != 1
        return out


RING_Z2_32 = Ring(bits=32)
RING_Z2_24 = Ring(bits=24)
RING_Z2_16 = Ring(bits=16)
RING_TIER = Ring(modulus=TIER_M)


class PadRNG:
    """The randomness behind s and e. Seeded from the OS CSPRNG unless a test
    passes an explicit seed; SECURITY.md records why a reproducible default
    here is the same thing as publishing the pads."""

    def __init__(self, seed=None):
        if seed is None:
            seed = int.from_bytes(os.urandom(32), "little")
            self.reproducible = False
        else:
            self.reproducible = True
        self.rng = np.random.default_rng(seed)


def public_matrix_rng(label, n, k):
    """The PUBLIC seed for A: anyone can rebuild A from (label, n, k). A is
    not secret and must not be -- the host needs nothing from it, and the
    security argument does not depend on it being hidden."""
    h = hashlib.sha256(f"enclave-lpn-A|{label}|{n}|{k}".encode()).digest()
    return np.random.default_rng(int.from_bytes(h[:8], "little"))


# ---------------------------------------------------------------------------
# The public matrix A, in three layouts
# ---------------------------------------------------------------------------
class PublicMatrix:
    """A (n x k) and the product A.s, in one of three layouts:

    dense     n.k uniform ring elements; A.s reads n.k.(bits/8) bytes. The
              handoff's A.
    dense8    n.k uniform BYTES lifted into the ring; 1 byte per entry.
    toeplitz  A[j, l] = a[j + l] for a of length n + k - 1; A.s is a
              correlation, n.k multiplies and no bandwidth to speak of.
    """

    MODES = ("dense", "dense8", "toeplitz")

    def __init__(self, ring, n, k, mode="toeplitz", label="v1"):
        if mode not in self.MODES:
            raise ValueError(mode)
        self.ring, self.n, self.k, self.mode = ring, int(n), int(k), mode
        rng = public_matrix_rng(f"{label}|{mode}", n, k)
        if mode == "dense":
            self.A = ring.uniform(rng, (n, k))
            self.bytes = n * k * ring.storage_bytes
        elif mode == "dense8":
            self.A = rng.integers(0, 256, size=(n, k), dtype=np.int64)
            self.bytes = n * k
        else:
            self.a = ring.uniform(rng, (n + k - 1,))
            self.A = None
            self.bytes = (n + k - 1) * ring.storage_bytes

    def dense(self):
        """Materialise A (tests and the W.A precompute)."""
        if self.A is not None:
            return self.A
        idx = np.arange(self.n)[:, None] + np.arange(self.k)[None, :]
        return self.a[idx]

    def times(self, S):
        """A.S for S of shape (k, B)."""
        return self.ring.matmul(self.dense(), S)


# ---------------------------------------------------------------------------
# Pad sources
# ---------------------------------------------------------------------------
class PadSource:
    """Fresh pads for one linear layer. pads(B) -> (R, U) with R: (n, B) the
    pads and U = W.R: (m, B), both canonical ring elements. Every call draws
    fresh randomness; nothing is banked or recombined."""

    kind = "abstract"

    def __init__(self, ring, W_lifted):
        self.ring = ring
        self.W = np.asarray(W_lifted, dtype=np.int64)     # (m, n), canonical
        self.m, self.n = self.W.shape
        self.issued = 0

    def pads(self, B):
        raise NotImplementedError

    def cost_bytes(self, B=1):
        """Bytes read per batch of B pads (the decode objective)."""
        raise NotImplementedError

    def cost_flops(self, B=1):
        """Multiplies per batch of B pads (the prefill objective)."""
        raise NotImplementedError


class UniformPads(PadSource):
    """The baseline: r uniform, u = W.r by a full pass over W."""

    kind = "uniform"

    def __init__(self, ring, W_lifted, rng: PadRNG, weight_bits=8):
        super().__init__(ring, W_lifted)
        self.rng, self.weight_bits = rng.rng, weight_bits

    def pads(self, B):
        R = self.ring.uniform(self.rng, (self.n, B))
        U = self.ring.matmul(self.W, R)
        self.issued += B
        return R, U

    def cost_bytes(self, B=1):
        return self.n * self.m * self.weight_bits / 8          # W once per batch

    def cost_flops(self, B=1):
        return self.n * self.m * B


class LPNPads(PadSource):
    """r = A.s + e with fresh (s, e); u = (W.A).s + W.e.

    regular=False: t noise positions uniformly without replacement.
    regular=True:  one noise position per block, blocks partitioning [0, n)
                   into t nearly equal contiguous ranges (regular LPN, the
                   PCG variant; strided gathers).
    """

    kind = "lpn"

    def __init__(self, ring, W_lifted, rng: PadRNG, k, t, regular=True,
                 a_mode="toeplitz", weight_bits=8, label="v1"):
        super().__init__(ring, W_lifted)
        if not (1 <= k <= self.n and 1 <= t <= self.n):
            raise ValueError(f"k={k}, t={t} outside [1, n={self.n}]")
        self.rng, self.k, self.t, self.regular = rng.rng, int(k), int(t), bool(regular)
        self.weight_bits = weight_bits
        self.A = PublicMatrix(ring, self.n, self.k, mode=a_mode, label=label)
        # The one-time precompute: W.A, m x k. Public function of public data;
        # cacheable next to the weights like a calibration file.
        self.WA = ring.matmul(self.W, self.A.dense())
        if self.regular:
            edges = np.linspace(0, self.n, self.t + 1).astype(np.int64)
            self.block_lo, self.block_hi = edges[:-1], edges[1:]
            assert np.all(self.block_hi > self.block_lo), "t > n: empty block"
        self.kind = "regular-lpn" if regular else "lpn"

    def noise(self, B):
        """(positions (t, B), values (t, B)). Positions distinct per column;
        values are ring units."""
        if self.regular:
            span = self.block_hi - self.block_lo
            pos = self.block_lo[:, None] + (self.rng.random((self.t, B)) * span[:, None]).astype(np.int64)
        else:
            pos = np.stack([self.rng.choice(self.n, self.t, replace=False) for _ in range(B)], axis=1)
        val = self.ring.unit(self.rng, (self.t, B))
        return pos, val

    def pads(self, B):
        S = self.ring.uniform(self.rng, (self.k, B))
        pos, val = self.noise(B)
        # r = A.s + e
        R = self.A.times(S)
        E = np.zeros((self.n, B), dtype=np.int64)
        cols = np.broadcast_to(np.arange(B)[None, :], pos.shape)
        E[pos, cols] = val
        R = self.ring.add(R, E)
        # u = (W.A).s + W.e   -- W.e as a gather of t columns per pad
        U = self.ring.matmul(self.WA, S)
        WE = np.zeros((self.m, B), dtype=np.int64)
        for b in range(B):
            # sum_j val[j,b] * W[:, pos[j,b]]  (the gather the C kernel does row-wise on W^T)
            WE[:, b] = self.ring.matmul(self.W[:, pos[:, b]], val[:, b])
        U = self.ring.add(U, WE)
        self.issued += B
        return R, U

    def cost_bytes(self, B=1):
        rb = self.ring.storage_bytes
        wa = self.m * self.k * rb                         # W.A once per batch
        gather = min(self.t * B, self.n) * self.m * self.weight_bits / 8
        return wa + gather + self.A.bytes

    def cost_flops(self, B=1):
        return (self.k * self.m + self.t * self.m + self.n * self.k) * B


# ---------------------------------------------------------------------------
# Integrity: preprocessed Freivalds over the integers
# ---------------------------------------------------------------------------
class Freivalds:
    """Checks y == W.x over the INTEGERS, mod an unrelated prime P2.

    A random vector over Z_2^b is a poor Freivalds witness (zero divisors: an
    error of 2^(b-1) in one coordinate is missed half the time), and a check
    mod the ring cannot see a wrap at all. Checking the balanced integers mod
    P2 = 2^31 - 1 catches a lying host AND a product that wrapped the ring,
    with the same two dot products -- the rule tee.py and shielded-tee.c
    follow. v is secret: a host that knew it could forge. reps=2 -> ~2^-62.
    """

    def __init__(self, W_signed, rng: PadRNG, reps=2):
        self.W = np.asarray(W_signed, dtype=np.int64)     # signed weights, (m, n)
        self.reps = reps
        self.v = rng.rng.integers(0, FV_P2, size=(reps, self.W.shape[0]), dtype=np.int64)
        # s~ = v.W mod P2, per rep: exact in chunks (|v| < 2^31, |w| < 2^8)
        self.vt = np.mod(self.v @ self.W, FV_P2)          # (reps, n); products < 2^39, n < 2^24

    @staticmethod
    def _dot_mod(a, b):
        """(a @ b) mod P2 for a: (reps, L) in [0, P2) and b: (L, B) signed.

        Exact int64 throughout: b is reduced mod P2 and split into 16-bit
        halves, so every product is < 2^47 and 2^15 of them sum below 2^62.
        The first version of this multiplied two 31-bit operands and
        overflowed int64 on the very first layer -- silently, since numpy
        wraps -- which is exactly the class of bug the check exists to catch.
        """
        acc = np.zeros((a.shape[0], b.shape[1]), dtype=np.int64)
        bm = np.mod(np.asarray(b, dtype=np.int64), FV_P2)
        lo, hi = bm & 0xFFFF, bm >> 16
        for k0 in range(0, a.shape[1], 1 << 15):
            ak = a[:, k0:k0 + (1 << 15)]
            p_lo = np.mod(ak @ lo[k0:k0 + (1 << 15)], FV_P2)
            p_hi = np.mod(ak @ hi[k0:k0 + (1 << 15)], FV_P2)
            acc = np.mod(acc + p_lo + np.mod(p_hi * (1 << 16), FV_P2), FV_P2)
        return acc

    def check(self, X_signed, Y_signed):
        """X: (n, B) signed activations, Y: (m, B) recovered signed products."""
        lhs = self._dot_mod(self.v, Y_signed)
        rhs = self._dot_mod(self.vt, X_signed)
        return bool(np.array_equal(lhs, rhs))


class IntegrityFailure(Exception):
    pass


# ---------------------------------------------------------------------------
# The offload: mask -> host -> unmask -> verify
# ---------------------------------------------------------------------------
class Host:
    """The untrusted side. Computes W.(X + R) in the ring. `tamper` makes it
    lie, for the integrity test."""

    def __init__(self, ring):
        self.ring = ring
        self.tamper = None
        self.seen = []

    def linear(self, W_lifted, Xm):
        Ym = self.ring.matmul(W_lifted, Xm)
        if self.tamper is not None:
            Ym = self.ring.add(Ym, self.tamper(Ym))
        return Ym


class MaskedLinear:
    """One offloaded linear layer with a pad source and a Freivalds checker."""

    def __init__(self, ring, W_signed, pads: PadSource, host: Host, fv: Freivalds, record=None):
        self.ring, self.W_signed, self.pads, self.host, self.fv = ring, np.asarray(W_signed, np.int64), pads, host, fv
        self.W = ring.lift(self.W_signed)
        self.record = record          # list to append (X, R, X+R) for the transcript tests

    def __call__(self, X_signed):
        """X: (n, B) signed. Returns W.X (m, B) as signed integers, exactly."""
        X_signed = np.asarray(X_signed, dtype=np.int64)
        B = X_signed.shape[1]
        R, U = self.pads.pads(B)
        Xm = self.ring.add(self.ring.lift(X_signed), R)
        if self.record is not None:
            self.record.append((X_signed.copy(), R.copy(), Xm.copy()))
        Ym = self.host.linear(self.W, Xm)
        Y = self.ring.balanced(self.ring.sub(Ym, U))
        if not self.fv.check(X_signed, Y):
            raise IntegrityFailure("Freivalds: host returned something other than W.x, or the product wrapped the ring")
        return Y


# ---------------------------------------------------------------------------
# A toy integer transformer to prove exactness across a whole forward pass
# ---------------------------------------------------------------------------
class ToyTransformer:
    """Decoder-only, integer linears, nonlinearities in float64 inside the TEE.

    Weights are int8 (a function of the seed). Activations are fixed point
    with `frac` fractional bits. The linears are the ONLY thing that may be
    offloaded, and each is a MaskedLinear or a plain in-TEE integer matmul;
    everything else (embedding, norms, attention, SiLU, sampling) is TEE-side
    float64 on exactly recovered integers. The masked run must therefore
    reproduce the plain run bit for bit, not approximately.
    """

    def __init__(self, vocab=64, d=64, ff=192, layers=2, heads=4, frac=8, seed=1, w_range=32):
        self.V, self.d, self.ff, self.L, self.H, self.frac = vocab, d, ff, layers, heads, frac
        g = np.random.default_rng(seed)
        w = lambda m, n: g.integers(-w_range, w_range + 1, size=(m, n), dtype=np.int64)
        self.embed = g.integers(-(1 << frac), (1 << frac) + 1, size=(vocab, d), dtype=np.int64)
        self.layers = []
        for _ in range(layers):
            self.layers.append({
                "qkv": w(3 * d, d), "o": w(d, d),
                "gateup": w(2 * ff, d), "down": w(d, ff),
            })
        self.lm_head = w(vocab, d)
        self.linears = [(li, name) for li in range(layers) for name in ("qkv", "o", "gateup", "down")] + [("head", "lm_head")]

    def weight(self, li, name):
        return self.lm_head if li == "head" else self.layers[li][name]

    # -- TEE-side nonlinearities, on exactly recovered integers ------------
    def _rmsnorm_q(self, x_signed):
        x = x_signed.astype(np.float64)
        x = x / np.sqrt(np.mean(x * x, axis=0, keepdims=True) + 1e-6)
        return np.rint(x * (1 << self.frac)).astype(np.int64)

    def _attention(self, qkv, pos0):
        """qkv: (3d, T) signed with 2*frac fractional bits. Returns (d, T)
        fixed point with frac bits."""
        d, H, T = self.d, self.H, qkv.shape[1]
        q, k, v = (qkv[i * d:(i + 1) * d].astype(np.float64) / (1 << (2 * self.frac)) for i in range(3))
        hd = d // H
        out = np.zeros((d, T))
        for h in range(H):
            qh, kh, vh = q[h * hd:(h + 1) * hd], k[h * hd:(h + 1) * hd], v[h * hd:(h + 1) * hd]
            scores = (qh.T @ kh) / np.sqrt(hd)                          # (T, T)
            mask = np.triu(np.ones((T, T), dtype=bool), 1)
            scores[mask] = -np.inf
            scores -= scores.max(axis=1, keepdims=True)
            p = np.exp(scores); p /= p.sum(axis=1, keepdims=True)
            out[h * hd:(h + 1) * hd] = vh @ p.T
        return np.rint(out * (1 << self.frac)).astype(np.int64)

    def _silu_gate(self, gu):
        ff = self.ff
        g = gu[:ff].astype(np.float64) / (1 << (2 * self.frac))
        u = gu[ff:].astype(np.float64) / (1 << (2 * self.frac))
        a = g / (1 + np.exp(-g)) * u
        return np.rint(a * (1 << self.frac)).astype(np.int64)

    def forward(self, tokens, linear_for):
        """tokens: list of ints. linear_for(li, name) -> callable(X)->W.X.
        Returns logits (V, T) as float64 and the per-linear products, so a
        test can compare two runs product by product."""
        T = len(tokens)
        x = self.embed[np.asarray(tokens)].T                     # (d, T), frac bits
        products = []
        for li, lyr in enumerate(self.layers):
            h = self._rmsnorm_q(x)
            qkv = linear_for(li, "qkv")(h); products.append(qkv)
            att = self._attention(qkv, 0)
            o = linear_for(li, "o")(att); products.append(o)
            x = x + (o >> self.frac)                              # back to frac bits (floor)
            h = self._rmsnorm_q(x)
            gu = linear_for(li, "gateup")(h); products.append(gu)
            a = self._silu_gate(gu)
            dn = linear_for(li, "down")(a); products.append(dn)
            x = x + (dn >> self.frac)
        h = self._rmsnorm_q(x)
        logits = linear_for("head", "lm_head")(h); products.append(logits)
        return logits.astype(np.float64) / (1 << (2 * self.frac)), products

    def generate(self, prompt, n_new, linear_for):
        """Greedy decode, recomputing the whole sequence each step (the toy
        has no KV cache; exactness is what is under test, not speed)."""
        toks = list(prompt)
        products = []
        for _ in range(n_new):
            logits, ps = self.forward(toks, linear_for)
            products.extend(ps)
            toks.append(int(np.argmax(logits[:, -1])))
        return toks, products


def plain_linear(W_signed):
    """The in-TEE integer matmul: the oracle every offload must match."""
    W = np.asarray(W_signed, dtype=np.int64)
    return lambda X: W @ np.asarray(X, dtype=np.int64)


def build_masked_model(model, ring, make_pads, host=None, fv_rng=None, record=None):
    """Wrap every linear of `model` in a MaskedLinear using make_pads(ring, W_lifted)."""
    host = host or Host(ring)
    fv_rng = fv_rng or PadRNG()
    table = {}
    for li, name in model.linears:
        W = model.weight(li, name)
        pads = make_pads(ring, ring.lift(W))
        table[(li, name)] = MaskedLinear(ring, W, pads, host, Freivalds(W, fv_rng), record=record)
    return (lambda li, name: table[(li, name)]), table, host


if __name__ == "__main__":
    # A short demonstration; the assertions live in test_lpnpad.py.
    ring = RING_Z2_32
    model = ToyTransformer()
    plain = lambda li, name: plain_linear(model.weight(li, name))
    toks_plain, prods_plain = model.generate([1, 2, 3], 4, plain)
    rng = PadRNG(seed=7)
    masked, table, host = build_masked_model(
        model, ring, lambda r, W: LPNPads(r, W, rng, k=16, t=8, regular=True))
    toks_lpn, prods_lpn = model.generate([1, 2, 3], 4, masked)
    same = toks_plain == toks_lpn and all(np.array_equal(a, b) for a, b in zip(prods_plain, prods_lpn))
    print(f"ring {ring.name}: tokens {toks_plain} vs {toks_lpn}; {len(prods_plain)} products, bit-identical: {same}")
    print(f"issued pads: {sum(t.pads.issued for t in table.values())}")
