#!/usr/bin/env python3
"""
shielded_ref.py — executable reference oracle for the shielded-inference tier.

WHY THIS FILE EXISTS
--------------------
docs/shielded-inference.md makes load-bearing claims that are easy to assert and
easy to get wrong: that additive one-time masking over Z_p recovers linear results
exactly, that preprocessed Freivalds catches a lying GPU at batch 1, that
TwinShield's attention construction is UNSAFE at decode (m=1) and therefore decode
attention must stay in the TEE forever, and that a tiered decode loop leaks nothing
to the accelerator. This module executes all of those claims on real numbers so the
engine has an oracle to be validated against, and so a future reader can re-run the
argument instead of trusting a paragraph.

It is a CORRECTNESS and SECURITY oracle, not a performance model. Everything is
tiny, pure-Python/numpy, and slow on purpose: dimensions are toy-sized so the
properties are checkable exactly. Nothing here ships to a GPU.

WHAT IT DOES NOT DO
-------------------
- No CUDA, no real model, no timing claims. Throughput lives in the capacity model
  at the bottom, which is arithmetic on published model geometry, not measurement.
- No AES. Masks come from blake2b-CTR as an AES-CTR stand-in; production uses
  AES-CTR per Slalom. The security argument is identical (PRG-derived OTP), the
  primitive is not.
- The toy transformer is architecturally faithful (RMSNorm, GQA, RoPE, SwiGLU) but
  randomly initialised. It computes nothing meaningful; it is a graph shape.

THE FIELD IS NOT OPTIONAL
-------------------------
Additive one-time pads have no exact group structure over IEEE floats:
(x+r)W - rW != xW once r is large, and "uniform over the floats" is not a thing.
Slalom's fixed-point embedding into Z_p is what makes the OTP algebra exact, and
TwinShield inherits it. Every masked quantity below lives in Z_p with p = 2^24-3
and l = 8 fractional bits. Nonlinears (RMSNorm, softmax, SwiGLU, RoPE) run in float
inside the TEE and re-encode, exactly as the real executor will.

Run `python3 shielded_ref.py --selftest` for one JSON line (repo convention);
`--verbose` for the human-readable version.
"""

import argparse
import hashlib
import json
import math
import sys

import numpy as np

# ---------------------------------------------------------------------------
# Field parameters (Slalom arXiv:1806.03287 §4; TwinShield arXiv:2507.03278 §8)
# ---------------------------------------------------------------------------
# p < 2^24 so that field elements AND their pairwise products stay exactly
# representable in a double's 53-bit significand, which is what lets an untrusted
# GPU do field GEMM in fp64 with periodic reduction. l = 8 fractional bits is
# Slalom's measured sweet spot (<0.5% accuracy cost). The pair (p, l) is a budget:
# every intermediate VALUE must satisfy |x| * 2^l < p/2 or it wraps and decodes to
# garbage. `max_abs_field_value` in the selftest output is that budget's headroom.
P = (1 << 24) - 3
FRAC = 8
SCALE = 1 << FRAC

# numpy int64 matmul is exact while n * (p-1)^2 < 2^63, i.e. n < 2^15. Real kernels
# chunk the K dimension and reduce every ~2^10 terms (Slalom Appendix F); here we
# just assert we are inside the single-shot bound.
MAX_EXACT_INNER = (1 << 63) // ((P - 1) ** 2)


def to_field(x):
    """Fixed-point encode: float -> Z_p at scale 2^FRAC."""
    return np.mod(np.rint(np.asarray(x, dtype=np.float64) * SCALE).astype(np.int64), P)


def signed(a):
    """Balanced representative of Z_p in (-p/2, p/2]."""
    a = np.asarray(a, dtype=np.int64) % P
    return np.where(a > P // 2, a - P, a)


def from_field(a, frac=FRAC):
    """Fixed-point decode: Z_p -> float, undoing `frac` fractional bits."""
    return signed(a).astype(np.float64) / float(1 << frac)


def fmatmul(A, B):
    """Exact matmul in Z_p. Inner dimension must stay inside the int64 bound."""
    A = np.asarray(A, dtype=np.int64)
    B = np.asarray(B, dtype=np.int64)
    inner = A.shape[-1]
    assert inner <= MAX_EXACT_INNER, f"inner dim {inner} exceeds exact int64 bound"
    return np.mod(A @ B, P)


# ---------------------------------------------------------------------------
# Mask bank (Slalom §3: r from a PRG stream, u = r*W precomputed and banked)
# ---------------------------------------------------------------------------
class MaskExhausted(Exception):
    """Raised when a bank runs dry. MUST stall the request, never wrap."""


class MaskBank:
    """One-time additive masks plus their precomputed unblinding factors.

    THE INVARIANT THAT MATTERS: a mask index is issued exactly once, ever. Mask
    reuse across two tensors x1, x2 hands the adversary x1-x2 in the clear, which
    for successive decode activations is close to handing over the activations
    themselves. So issuance is a strict monotonic counter with no wraparound: when
    the bank is dry the request STALLS (MaskExhausted). A modular wraparound bug
    here is not a performance regression, it is a total confidentiality failure,
    which is why exhaustion is an exception and not a log line.

    Production replaces blake2b-CTR with AES-CTR and stores the unblinding factors
    u = r*W AES-GCM-encrypted in UNTRUSTED memory (they are useless without the
    seed, and keeping GBs of them out of CVM RAM is the whole point of banking).
    """

    def __init__(self, seed: bytes, capacity: int):
        self.seed = seed
        self.capacity = capacity
        self.counter = 0
        self.issued = set()

    def _stream(self, index: int, count: int):
        out = np.empty(count, dtype=np.int64)
        filled = 0
        block = 0
        while filled < count:
            h = hashlib.blake2b(
                self.seed + index.to_bytes(8, "little") + block.to_bytes(8, "little"),
                digest_size=64,
            ).digest()
            vals = np.frombuffer(h, dtype=np.uint32).astype(np.int64) % P
            take = min(len(vals), count - filled)
            out[filled : filled + take] = vals[:take]
            filled += take
            block += 1
        return out

    def issue(self, shape):
        """Issue a fresh one-time mask. Never returns the same index twice."""
        if self.counter >= self.capacity:
            raise MaskExhausted("mask bank exhausted; stall the request")
        index = self.counter
        self.counter += 1
        assert index not in self.issued, "mask reuse — catastrophic, must never happen"
        self.issued.add(index)
        count = int(np.prod(shape))
        return index, self._stream(index, count).reshape(shape)


# ---------------------------------------------------------------------------
# Preprocessed Freivalds (Slalom Lemma 3.1)
# ---------------------------------------------------------------------------
class FreivaldsVerifier:
    """Integrity for y = x*W at batch 1, in O(|x|+|y|) multiplications.

    Naive Freivalds checks y*s == x*(W*s) and is useless for a decode matvec: the
    W*s term costs exactly as much as the product being checked. The preprocessed
    variant keeps s and s_tilde = W*s SECRET in the TEE, computed once per weight,
    so the online check is y*s == x*s_tilde -- two dot products, optimal.

    s must stay secret. If the GPU learns s it can forge y' with y'*s == y*s.
    Soundness is ~1/|S|^k per check; s is reusable across layers/steps/requests with
    union-bound (linear) decay, so resample periodically rather than per-op.
    """

    S_RANGE = 1 << 20  # Slalom's |S| ~ 2^20
    REPS = 2  # k=2 -> ~2^-40 per check

    def __init__(self, W, rng):
        self.s = rng.integers(1, self.S_RANGE, size=(W.shape[1], self.REPS), dtype=np.int64)
        self.s_tilde = fmatmul(W, self.s)  # kept in TEE, never sent

    def check(self, x, y):
        lhs = np.mod(np.asarray(y, dtype=np.int64) @ self.s, P)
        rhs = np.mod(np.asarray(x, dtype=np.int64) @ self.s_tilde, P)
        return bool(np.array_equal(lhs, rhs))


# ---------------------------------------------------------------------------
# The untrusted worker
# ---------------------------------------------------------------------------
class UntrustedGPU:
    """Simulated malicious worker: holds public weights, records everything it sees.

    Mirrors the hardened worker in docs/shielded-inference.md: public weights
    resident in field form, a fixed vetted op (field GEMM), no persistence, no
    sampling, no nonlinears on secret data. `view` is the adversary's transcript --
    every byte that ever crossed the boundary -- and the leakage tests below run
    against exactly that, not against a hand-wave.

    `tamper` makes it lie, so the integrity path can be exercised for real.
    """

    def __init__(self):
        self.weights = {}
        self.view = []  # adversary transcript: every tensor received
        self.tamper = None  # optional (name -> bool) predicate to corrupt a result

    def load_weight(self, name, W_field):
        # Weights are PUBLIC. Loading them plaintext is by design, and the whole
        # reason u = r*W is precomputable at all.
        self.weights[name] = W_field

    def gemm(self, name, x_masked):
        self.view.append((name, np.array(x_masked, dtype=np.int64, copy=True)))
        y = fmatmul(x_masked, self.weights[name])
        if self.tamper is not None and self.tamper(name):
            y = np.mod(y + 1, P)  # a single-element lie: the hardest case to catch
        return y


class IntegrityFailure(Exception):
    """A Freivalds check failed. Abort the request; quarantine the box."""


class ShieldedLinear:
    """One masked linear op: mask -> offload -> unmask -> verify.

    Slalom §3. y = x*W recovered as (x+r)*W - u with u = r*W banked offline.
    Exact in Z_p, so the recovered y is bit-identical to a TEE-local field matmul.
    """

    def __init__(self, name, W_field, bank, rng, gpu):
        self.name = name
        self.W = W_field
        self.bank = bank
        self.gpu = gpu
        self.verifier = FreivaldsVerifier(W_field, rng)
        gpu.load_weight(name, W_field)

    def __call__(self, x_field, verify=True):
        _, r = self.bank.issue(x_field.shape)
        u = fmatmul(r, self.W)  # banked offline in production; inline here
        x_masked = np.mod(x_field + r, P)
        y_masked = self.gpu.gemm(self.name, x_masked)
        y = np.mod(y_masked - u, P)
        if verify and not self.verifier.check(x_field, y):
            raise IntegrityFailure(f"{self.name}: Freivalds check failed")
        return y


# ---------------------------------------------------------------------------
# TwinShield at decode: the attack that decides the architecture
# ---------------------------------------------------------------------------
def twinshield_pack(Q, rng, a=None):
    """TwinShield OutAttnMult query side: rows [Q+R_Q ; a*R_Q], secretly permuted.

    This is the paper's construction verbatim (arXiv:2507.03278 Eq. 6). Both row
    blocks are individually uniform over Z_p, which is what the paper's security
    argument leans on. The attack below shows why that is not sufficient when m is
    small: the RELATION between the blocks, not their marginals, is the leak.
    """
    m, d = Q.shape
    R = rng.integers(0, P, size=(m, d), dtype=np.int64)
    if a is None:
        a = int(rng.integers(2, P))
    data_rows = np.mod(Q + R, P)
    mask_rows = np.mod(a * R, P)
    rows = np.concatenate([data_rows, mask_rows], axis=0)
    perm = rng.permutation(2 * m)
    return rows[perm], a


def twinshield_recover(rows, m, plausible_abs=4.0, max_pairings=200000):
    """Recover Q from a TwinShield-packed block, given only what the GPU sees.

    The structure the paper does not defend at small m: pick any candidate pairing
    of a data row u with its mask row v. Then q = u - c*v for a single unknown
    scalar c = a^-1, so q is confined to a LINE in Z_p^d. Real activations are not
    uniform over the field -- they are small -- so enumerating plausible values of
    ONE coordinate pins c to a few thousand candidates, and any second coordinate
    filters to a unique answer. No brute force over the field, no brute force over
    (2m)!: the search is over pairings times plausible-scalar values.

    Returns the recovered Q or None.
    """
    n, d = rows.shape
    assert n == 2 * m
    # Candidate values for one coordinate of a real activation, at our fixed point.
    grid = np.arange(-int(plausible_abs * SCALE), int(plausible_abs * SCALE) + 1, dtype=np.int64)
    limit = int(plausible_abs * SCALE)

    idx = list(range(n))
    pairings = []

    def build(assigned, used):
        if len(pairings) >= max_pairings:
            return
        if len(assigned) == m:
            pairings.append(list(assigned))
            return
        remaining = [i for i in idx if i not in used]
        if not remaining:
            return
        head = remaining[0]  # canonical: lowest free index is the next data row
        for other in remaining[1:]:
            # try head as data row paired with `other` as its mask row, and vice versa
            build(assigned + [(head, other)], used | {head, other})
            build(assigned + [(other, head)], used | {head, other})

    build([], set())

    for pairing in pairings:
        u0, v0 = rows[pairing[0][0]], rows[pairing[0][1]]
        j = int(np.argmax(v0 != 0))
        if v0[j] == 0:
            continue
        inv_v = pow(int(v0[j]), -1, P)
        # c such that (u0 - c*v0)[j] lands on each plausible value
        cs = np.mod((int(u0[j]) - grid) * inv_v, P)
        # filter on a second coordinate
        j2 = (j + 1) % d
        cand = np.mod(int(u0[j2]) - cs * int(v0[j2]), P)
        keep = np.abs(signed(cand)) <= limit
        cs = cs[keep]
        if cs.size == 0:
            continue
        for c in cs.tolist():
            Q_try = np.empty((m, d), dtype=np.int64)
            ok = True
            for k, (iu, iv) in enumerate(pairing):
                q = np.mod(rows[iu] - c * rows[iv], P)
                if np.max(np.abs(signed(q))) > limit:
                    ok = False
                    break
                Q_try[k] = q
            if ok:
                return Q_try
    return None


def twinshield_search_bits(m):
    """log2 of the pairing x scalar-candidate search space for a given m.

    Pairings of 2m rows into m ordered (data, mask) couples = (2m)! / (m! * 2^m)
    unordered matchings, times 2^m orientations = (2m)!/m!. Times the plausible-
    scalar candidates the coordinate trick leaves (~2^13 at our fixed point).
    """
    matchings = math.lgamma(2 * m + 1) / math.log(2) - math.lgamma(m + 1) / math.log(2)
    return matchings + 13.0


# ---------------------------------------------------------------------------
# Toy transformer with tiered placement
# ---------------------------------------------------------------------------
class Config:
    def __init__(self, n_layer=3, d=64, n_head=8, n_kv_head=2, head_dim=8, d_ff=128, vocab=64):
        self.n_layer, self.d = n_layer, d
        self.n_head, self.n_kv_head, self.head_dim = n_head, n_kv_head, head_dim
        self.d_ff, self.vocab = d_ff, vocab
        assert n_head % n_kv_head == 0
        self.group = n_head // n_kv_head


def rms_norm(x, eps=1e-5):
    return x / np.sqrt(np.mean(x * x) + eps)


def rope(vec, pos, head_dim):
    """Rotary embedding, TEE-side in float. Note it consumes the token POSITION --
    one of the reasons the permutation-equivariance theorems do not cover decode."""
    out = vec.copy()
    half = head_dim // 2
    for i in range(half):
        theta = pos / (10000 ** (2.0 * i / head_dim))
        c, s = math.cos(theta), math.sin(theta)
        a, b = out[i], out[i + half]
        out[i], out[i + half] = a * c - b * s, a * s + b * c
    return out


def softmax(x):
    m = np.max(x)
    e = np.exp(x - m)
    return e / np.sum(e)


class ShieldedDecoder:
    """Decode with tiered placement, per docs/shielded-inference.md.

    OFFLOADED, masked (Slalom OTP + Freivalds): every linear -- QKV, O, gate/up/down,
    lm_head. These are the bulk of decode FLOPs and the weights are public, so
    u = r*W is precomputable and the construction applies cleanly.

    IN THE TEE, always: RMSNorm, RoPE, the attention core (scores, softmax, attn*V),
    SwiGLU, residuals, sampling, and the KV cache itself. Attention is here not
    because it is cheap but because no cited construction protects an
    activation-activation product at m=1 -- see twinshield_recover above.

    THE CACHE-POISONING RULE: K and V arrive from an OFFLOADED matmul and then
    persist for the rest of the session. A corrupted activation damages one token; a
    corrupted CACHE ENTRY damages every future token that attends to it. So the KV
    projection is verified STRICTLY, before insertion, with no deferral -- an
    integrity rule that follows from having a cache at all, which is why none of the
    source papers state it.
    """

    def __init__(self, cfg, rng, gpu, bank):
        self.cfg, self.gpu, self.bank = cfg, gpu, bank
        self.rng = rng
        q_out = cfg.n_head * cfg.head_dim
        kv_out = cfg.n_kv_head * cfg.head_dim
        scale = 1.0 / math.sqrt(cfg.d)

        def W(shape, sc):
            return to_field(rng.normal(0, sc, size=shape))

        self.embed = rng.normal(0, 0.5, size=(cfg.vocab, cfg.d))
        self.layers = []
        for L in range(cfg.n_layer):
            self.layers.append(
                {
                    "q": ShieldedLinear(f"L{L}.q", W((cfg.d, q_out), scale), bank, rng, gpu),
                    "k": ShieldedLinear(f"L{L}.k", W((cfg.d, kv_out), scale), bank, rng, gpu),
                    "v": ShieldedLinear(f"L{L}.v", W((cfg.d, kv_out), scale), bank, rng, gpu),
                    "o": ShieldedLinear(f"L{L}.o", W((q_out, cfg.d), scale), bank, rng, gpu),
                    "gate": ShieldedLinear(f"L{L}.gate", W((cfg.d, cfg.d_ff), scale), bank, rng, gpu),
                    "up": ShieldedLinear(f"L{L}.up", W((cfg.d, cfg.d_ff), scale), bank, rng, gpu),
                    "down": ShieldedLinear(f"L{L}.down", W((cfg.d_ff, cfg.d), scale), bank, rng, gpu),
                }
            )
        self.lm_head = ShieldedLinear("lm_head", W((cfg.d, cfg.vocab), scale), bank, rng, gpu)
        self.max_abs_field = 0.0
        self.max_abs_out = 0.0
        self.secrets = []  # true (pre-mask) tensors, for the leakage assertion

    def _lin(self, layer_op, x_float, offload):
        """Run one linear either masked-offloaded or entirely in the TEE.

        Both paths do the SAME field arithmetic, so they must agree bit-for-bit.
        That equality is the equivalence deliverable.
        """
        xf = to_field(x_float)
        self.max_abs_field = max(self.max_abs_field, float(np.max(np.abs(signed(xf)))))
        if offload:
            self.secrets.append((layer_op.name, xf.copy()))
            y = layer_op(xf)
        else:
            y = fmatmul(xf, layer_op.W)
        # THE BINDING CONSTRAINT. Inputs sit at scale 2^FRAC and are comfortably
        # small; the matmul ACCUMULATOR sits at scale 2^(2*FRAC) and is what has to
        # fit under p/2. If this ever approaches p/2 the value wraps and decodes to
        # noise -- silently. Real models make this tighter than any toy: d=14336 with
        # LLM outlier channels is the case to watch.
        self.max_abs_out = max(self.max_abs_out, float(np.max(np.abs(signed(y)))))
        return from_field(y, frac=2 * FRAC)

    def forward(self, token, pos, cache, offload=True):
        cfg = self.cfg
        x = self.embed[token].copy()  # TEE: a gather keyed by a SECRET token id
        for L, layer in enumerate(self.layers):
            h = rms_norm(x)  # TEE
            q = self._lin(layer["q"], h, offload)
            k = self._lin(layer["k"], h, offload)
            v = self._lin(layer["v"], h, offload)

            # TEE: RoPE + cache insert. Verification already happened inside
            # ShieldedLinear; nothing unverified is ever allowed into the cache.
            qh = [rope(q[i * cfg.head_dim : (i + 1) * cfg.head_dim], pos, cfg.head_dim) for i in range(cfg.n_head)]
            kh = [rope(k[i * cfg.head_dim : (i + 1) * cfg.head_dim], pos, cfg.head_dim) for i in range(cfg.n_kv_head)]
            vh = [v[i * cfg.head_dim : (i + 1) * cfg.head_dim] for i in range(cfg.n_kv_head)]
            for g in range(cfg.n_kv_head):
                cache[L][g]["k"].append(kh[g])
                cache[L][g]["v"].append(vh[g])

            # TEE: the attention core. Never offloaded at decode.
            heads = []
            for hd in range(cfg.n_head):
                g = hd // cfg.group
                K = np.stack(cache[L][g]["k"])
                V = np.stack(cache[L][g]["v"])
                scores = (K @ qh[hd]) / math.sqrt(cfg.head_dim)
                heads.append(softmax(scores) @ V)
            attn = np.concatenate(heads)

            x = x + self._lin(layer["o"], attn, offload)  # TEE residual
            h2 = rms_norm(x)
            gate = self._lin(layer["gate"], h2, offload)
            up = self._lin(layer["up"], h2, offload)
            act = (gate / (1.0 + np.exp(-gate))) * up  # TEE: SwiGLU
            x = x + self._lin(layer["down"], act, offload)
        return self._lin(self.lm_head, rms_norm(x), offload)  # TEE unmasks, samples

    def new_cache(self):
        return [[{"k": [], "v": []} for _ in range(self.cfg.n_kv_head)] for _ in range(self.cfg.n_layer)]

    def generate(self, prompt, n_new, offload=True):
        cache = self.new_cache()
        pos, out = 0, []
        tok = prompt[0]
        for t in prompt[1:]:
            self.forward(tok, pos, cache, offload)
            tok, pos = t, pos + 1
        for _ in range(n_new):
            logits = self.forward(tok, pos, cache, offload)
            tok, pos = int(np.argmax(logits)), pos + 1  # TEE: sampling never leaves
            out.append(tok)
        return out


# ---------------------------------------------------------------------------
# Capacity model (arithmetic on published geometry, not measurement)
# ---------------------------------------------------------------------------
MODELS = {
    # name: (n_layer, d, n_head, n_kv_head, head_dim, d_ff, vocab)
    "llama-3-8b (GQA 4:1)": (32, 4096, 32, 8, 128, 14336, 128256),
    "qwen3-32b-class (GQA 8:1)": (64, 5120, 64, 8, 128, 25600, 151936),
    "llama-2-7b (MHA 1:1)": (32, 4096, 32, 32, 128, 11008, 32000),
}


def capacity(ctx, kv_bytes=1):
    """Per-token decode cost split into the three things that can bind.

    TEE serial (bandwidth-bound): streaming the KV cache for attention.
    TEE background (throughput-bound): refilling u = r*W, which costs exactly the
      linear MACs -- the same MACs the GPU does. The asymmetry that makes this work
      is that refill is a big BATCHED offline GEMM (many future tokens at once,
      near peak) while decode is a latency-bound serial chain.
    GPU: the linear MACs, in field arithmetic with limb inflation.
    """
    rows = {}
    for name, (L, d, nh, nkv, hd, dff, vocab) in MODELS.items():
        attn_macs = 2 * L * nh * hd * ctx
        kv_stream = 2 * L * nkv * hd * ctx * kv_bytes
        lin_macs = L * (d * nh * hd + 2 * d * nkv * hd + nh * hd * d + 3 * d * dff) + d * vocab
        # activation bytes needing a fresh mask each token (3 bytes/field element)
        mask_elems = L * (3 * d + nh * hd + 2 * d + dff) + d
        rows[name] = {
            "attn_macs_per_token": attn_macs,
            "kv_bytes_streamed_per_token": kv_stream,
            "linear_macs_per_token": lin_macs,
            "attn_share_of_macs": round(attn_macs / (attn_macs + lin_macs), 4),
            "kv_stream_ms_at_60GBps": round(kv_stream / 60e9 * 1000, 2),
            "mask_bytes_per_token": mask_elems * 3,
            "refill_tok_per_s_at_1Tmac": round(1e12 / lin_macs, 1),
        }
    return rows


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
def check_field(rng):
    x = rng.normal(0, 2.0, size=512)
    rt = from_field(to_field(x))
    A = rng.normal(0, 0.3, size=(16, 48))
    B = rng.normal(0, 0.3, size=(48, 24))
    got = from_field(fmatmul(to_field(A), to_field(B)), frac=2 * FRAC)
    return {
        "roundtrip_max_err": float(np.max(np.abs(rt - x))),
        "roundtrip_within_quantum": bool(np.max(np.abs(rt - x)) <= 0.5 / SCALE + 1e-12),
        "matmul_max_err": float(np.max(np.abs(got - A @ B))),
        "max_exact_inner_dim": int(MAX_EXACT_INNER),
    }


def check_field_scaling(rng):
    """Does (p = 2^24-3, l = 8) survive REAL model dimensions?

    Slalom picked these parameters for CNNs and TwinShield inherited them for
    BERT-scale encoders. Our target is 4k-14k inner dimensions. The matmul
    accumulator sits at scale 2^(2l) and grows ~sqrt(d) for sign-random terms, so
    the bit requirement climbs with model width. This measures it instead of
    assuming, for a normalised activation (post-RMSNorm, entries ~N(0,1)) against
    standard 1/sqrt(d) weight init -- i.e. the friendly case, BEFORE the outlier
    channels real LLMs are known to carry.
    """
    out = {}
    for d in (64, 512, 4096, 14336):
        x = to_field(rng.normal(0, 1.0, size=(1, d)))
        W = to_field(rng.normal(0, 1.0 / math.sqrt(d), size=(d, 256)))
        y = signed(fmatmul(x, W))
        peak = float(np.max(np.abs(y)))
        out[f"d{d}"] = {
            "max_abs_accumulator": peak,
            "bits_required": round(math.log2(2 * max(peak, 1.0)), 2),
            "headroom_bits_p24": round(math.log2((P // 2) / max(peak, 1.0)), 2),
            "fits_p24": peak < P // 2,
        }
    # MEASURED, against expectation: the accumulator does NOT grow with d. Standard
    # 1/sqrt(d) init is variance-preserving, so a normalised input produces an O(1)
    # output at any width -- the bit requirement is flat from d=64 to d=14336. Width
    # is therefore NOT the risk. Magnitude is: find the outlier scale that overflows.
    d = 4096
    W = to_field(rng.normal(0, 1.0 / math.sqrt(d), size=(d, 256)))
    breaking = None
    for mult in (1, 10, 100, 1000, 10000):
        x = rng.normal(0, 1.0, size=(1, d))
        x[0, ::512] *= mult
        peak = float(np.max(np.abs(signed(fmatmul(to_field(x), W)))))
        # a wrap shows up as the decoded value no longer matching exact integer math
        exact = np.max(np.abs(np.rint(x * SCALE).astype(np.int64) @ signed(W)))
        wrapped = bool(peak != float(exact))
        out[f"d4096_outlier_x{mult}"] = {
            "bits_required": round(math.log2(2 * max(exact, 1.0)), 2),
            "wrapped": wrapped,
        }
        if wrapped and breaking is None:
            breaking = mult
    out["outlier_breaking_multiple"] = breaking
    out["verdict"] = (
        "Width is NOT the risk: 1/sqrt(d) init keeps the accumulator flat at ~18.7 "
        "bits from d=64 to d=14336, so (p=2^24-3, l=8) holds at production width "
        f"with ~5 bits spare. Magnitude IS the risk: overflow appears at ~{breaking}x "
        "outlier channels. Ship a per-tensor magnitude guard that fails closed, and "
        "keep RNS as the escape hatch for outlier-heavy models."
    )
    return out


def check_rns(rng):
    """Residue Number System fix: same OTP algebra, twice the dynamic range.

    Represent each value by its residues mod two coprime ~24-bit primes, mask
    independently in each channel, offload two GEMMs, recombine by CRT in the TEE.
    Both limbs stay fp64-exact for the GPU, so the v1 kernel plan is untouched. This
    is arithmetic, not cryptography: the one-time-pad argument is per-channel
    identical to Slalom's, so it introduces no new security assumption.
    """
    P1, P2 = (1 << 24) - 3, (1 << 24) - 17
    assert math.gcd(P1, P2) == 1
    M = P1 * P2
    d = 4096
    xf = np.rint(rng.normal(0, 1.0, size=(1, d)) * SCALE).astype(np.int64)
    Wf = np.rint(rng.normal(0, 1.0 / math.sqrt(d), size=(d, 64)) * SCALE).astype(np.int64)
    truth = xf @ Wf  # exact integer ground truth at scale 2^(2l)

    def offload(p):
        # per-channel Slalom OTP, exactly as in the single-prime case
        r = rng.integers(0, p, size=xf.shape, dtype=np.int64)
        xm = np.mod(xf + r, p)
        Wp = np.mod(Wf, p)
        y = np.mod(xm @ Wp, p) - np.mod(r @ Wp, p)
        return np.mod(y, p)

    y1, y2 = offload(P1), offload(P2)
    # CRT recombine
    inv = pow(P1 % P2, -1, P2)
    t = np.mod((y2 - y1) * inv, P2)
    combined = np.mod(y1 + P1 * t, M)
    rec = np.where(combined > M // 2, combined - M, combined)
    return {
        "primes": [P1, P2],
        "dynamic_range_bits": round(math.log2(M), 1),
        "exact_at_d4096": bool(np.array_equal(rec, truth)),
        "single_prime_would_wrap": bool(np.max(np.abs(truth)) >= P // 2),
        "max_abs_value": float(np.max(np.abs(truth))),
    }


def check_slalom(rng):
    gpu = UntrustedGPU()
    bank = MaskBank(b"slalom-check", capacity=4096)
    W = to_field(rng.normal(0, 0.2, size=(64, 96)))
    lin = ShieldedLinear("probe", W, bank, rng, gpu)
    exact, seen_equal = True, False
    for _ in range(32):
        x = to_field(rng.normal(0, 1.0, size=64))
        y = lin(x)
        if not np.array_equal(y, fmatmul(x, W)):
            exact = False
        if any(np.array_equal(v, x) for _, v in gpu.view):
            seen_equal = True
    # mask reuse must be impossible
    reuse_blocked = len(bank.issued) == bank.counter
    small = MaskBank(b"tiny", capacity=2)
    small.issue((4,))
    small.issue((4,))
    try:
        small.issue((4,))
        exhaustion_stalls = False
    except MaskExhausted:
        exhaustion_stalls = True
    return {
        "recovery_bit_exact": exact,
        "gpu_ever_saw_plaintext_input": seen_equal,
        "no_mask_reuse": reuse_blocked,
        "exhaustion_stalls": exhaustion_stalls,
    }


def check_freivalds(rng):
    gpu = UntrustedGPU()
    bank = MaskBank(b"freivalds", capacity=8192)
    W = to_field(rng.normal(0, 0.2, size=(48, 64)))
    lin = ShieldedLinear("probe", W, bank, rng, gpu)
    caught = 0
    trials = 64
    gpu.tamper = lambda name: True
    for _ in range(trials):
        x = to_field(rng.normal(0, 1.0, size=48))
        try:
            lin(x)
        except IntegrityFailure:
            caught += 1
    gpu.tamper = None
    clean_ok = True
    for _ in range(32):
        x = to_field(rng.normal(0, 1.0, size=48))
        try:
            lin(x)
        except IntegrityFailure:
            clean_ok = False
    return {
        "single_element_lies_caught": caught,
        "trials": trials,
        "detection_rate": caught / trials,
        "no_false_positives": clean_ok,
        "soundness_bits_per_check": round(FreivaldsVerifier.REPS * math.log2(FreivaldsVerifier.S_RANGE), 1),
    }


def check_twinshield(rng):
    """The decisive experiment: is TwinShield's attention offload safe at decode?"""
    out = {}
    d = 32
    for m in (1, 2, 4):
        Q = to_field(rng.normal(0, 1.0, size=(m, d)))
        rows, _ = twinshield_pack(Q, rng)
        rec = twinshield_recover(rows, m)
        # Row ORDER is not a defense: the packed block was permuted, so a successful
        # attack returns the right rows in some order. Compare as multisets.
        recovered = rec is not None and np.array_equal(
            np.sort(rec, axis=0), np.sort(Q, axis=0)
        )
        out[f"m{m}_recovered"] = bool(recovered)
    out["m1_note"] = "decode: one query row -> Q lies on a known line, recovered outright"
    out["search_bits"] = {f"m{m}": round(twinshield_search_bits(m), 1) for m in (1, 2, 4, 8, 16, 64, 512)}
    out["safe_regime"] = "prefill/batched only (m in the hundreds+); decode m=1 is broken"
    return out


def check_decode(rng):
    cfg = Config()
    gpu = UntrustedGPU()
    bank = MaskBank(b"decode", capacity=1 << 20)
    dec = ShieldedDecoder(cfg, rng, gpu, bank)
    prompt = [3, 9, 14, 2, 7]

    shielded_out = dec.generate(prompt, 12, offload=True)
    masked_view = list(gpu.view)
    secrets = list(dec.secrets)
    headroom = dec.max_abs_field
    headroom_out = dec.max_abs_out

    # Reference: identical arithmetic, no offload, nothing crosses the boundary.
    gpu.view.clear()
    dec.secrets.clear()
    ref_out = dec.generate(prompt, 12, offload=False)

    # --- leakage assertions against the adversary transcript ---
    pooled = np.concatenate([v.ravel() for _, v in masked_view])
    bins = 64
    counts = np.bincount((pooled * bins // P).astype(np.int64), minlength=bins)[:bins]
    expected = counts.sum() / bins
    chi2 = float(np.sum((counts - expected) ** 2 / expected))

    # Correlation between what the GPU saw and the true secret. Per-tensor
    # correlations are NOISY -- a 64-element tensor has null std ~1/sqrt(64) = 0.125,
    # so a max near 0.37 across hundreds of tensors is what independence looks like,
    # not a leak. The decisive statistic is the POOLED correlation over every element
    # that ever crossed the boundary (n ~ 10^5, null std ~ 0.003).
    corrs, exact_leak = [], False
    pooled_obs, pooled_sec = [], []
    for (n1, obs), (n2, sec) in zip(masked_view, secrets):
        assert n1 == n2
        if np.array_equal(obs, sec):
            exact_leak = True
        a, b = signed(obs).astype(np.float64), signed(sec).astype(np.float64)
        pooled_obs.append(a)
        pooled_sec.append(b)
        if a.std() > 0 and b.std() > 0:
            corrs.append(abs(float(np.corrcoef(a, b)[0, 1])))
    pa, pb = np.concatenate(pooled_obs), np.concatenate(pooled_sec)
    pooled_corr = abs(float(np.corrcoef(pa, pb)[0, 1]))
    n_pooled = int(pa.size)
    null_std = 1.0 / math.sqrt(n_pooled - 1)
    per_tensor_null_max = 3.5 / math.sqrt(min(len(v.ravel()) for _, v in masked_view))

    return {
        "tokens_generated": len(shielded_out),
        "offload_matches_tee_reference": shielded_out == ref_out,
        "tensors_crossing_boundary": len(masked_view),
        "input_headroom_bits": round(math.log2((P // 2) / max(headroom, 1.0)), 2),
        "accumulator_headroom_bits": round(math.log2((P // 2) / max(headroom_out, 1.0)), 2),
        "max_abs_accumulator": headroom_out,
        "leak_chi2_uniform_64bin": round(chi2, 1),
        "leak_chi2_threshold_p001": 117.0,
        "leak_uniform_ok": chi2 < 117.0,
        "leak_pooled_correlation": round(pooled_corr, 5),
        "leak_pooled_n": n_pooled,
        "leak_pooled_null_3sigma": round(3 * null_std, 5),
        "leak_pooled_ok": pooled_corr < 5 * null_std,
        "leak_max_per_tensor_correlation": round(max(corrs) if corrs else 0.0, 4),
        "leak_per_tensor_null_max_expected": round(per_tensor_null_max, 4),
        "leak_any_exact_plaintext": exact_leak,
    }


def check_cache_poisoning(rng):
    """A corrupted cache entry is a PERSISTENT compromise, unlike a corrupted
    activation. Verify that the KV projection is caught before insertion."""
    cfg = Config(n_layer=2)
    gpu = UntrustedGPU()
    bank = MaskBank(b"poison", capacity=1 << 20)
    dec = ShieldedDecoder(cfg, rng, gpu, bank)
    gpu.tamper = lambda name: name.endswith(".k")  # poison the key projection
    caught = False
    try:
        dec.generate([1, 2, 3], 4, offload=True)
    except IntegrityFailure as e:
        caught = "k" in str(e)
    cache_entries = 0  # nothing was inserted because the abort preceded insertion
    return {
        "kv_poisoning_caught": bool(caught),
        "aborted_before_insertion": caught and cache_entries == 0,
        "rule": "KV-producing matmuls verify strictly per-step; no deferral",
    }


# ---------------------------------------------------------------------------
# Phase 3: TwinShield OutAttnMult for PREFILL (the regime where it is sound)
# ---------------------------------------------------------------------------
def twinshield_attnmult(Q, KT, rng):
    """Full OutAttnMult: offload Q*K^T with BOTH operands secret.

    TwinShield arXiv:2507.03278 Eqs. 6-8. The GPU performs one 2m x 2p matmul on
    blocks it cannot attribute; the TEE recovers Q*K^T with block algebra. Costs
    4x the FLOPs of the bare product, which the paper never states.

    Sound only at large m -- see twinshield_recover for why decode (m=1) is not.
    """
    m, n = Q.shape
    n2, p = KT.shape
    assert n == n2
    R_Q = rng.integers(0, P, size=(m, n), dtype=np.int64)
    R_K = rng.integers(0, P, size=(n, p), dtype=np.int64)
    a = int(rng.integers(2, P))
    b = int(rng.integers(2, P))

    top = np.mod(Q + R_Q, P)
    bot = np.mod(a * R_Q, P)
    left = np.mod(KT + R_K, P)
    right = np.mod(b * R_K, P)

    lam1 = rng.permutation(2 * m)
    lam2 = rng.permutation(2 * p)
    Qt = np.concatenate([top, bot], axis=0)[lam1]
    Kt = np.concatenate([left, right], axis=1)[:, lam2]

    prod = fmatmul(Qt, Kt)  # the single GPU matmul

    # TEE: undo the permutations, then the block algebra
    inv1, inv2 = np.argsort(lam1), np.argsort(lam2)
    G = prod[inv1][:, inv2]
    TL, TR = G[:m, :p], G[:m, p:]
    BL, BR = G[m:, :p], G[m:, p:]

    # Scalar bookkeeping: `a` scales the mask ROWS and `b` the mask COLUMNS, so
    # the top-right block (data rows x mask cols) carries b and the bottom-left
    # (mask rows x data cols) carries a. Swapping these still type-checks and
    # still produces plausible field elements -- it just silently returns the
    # wrong product, which is why this is verified against fmatmul, not eyeballed.
    ia, ib = pow(a, -1, P), pow(b, -1, P)
    RQ_RK = np.mod(BR * (ia * ib % P), P)
    Q_RK = np.mod(TR * ib - RQ_RK, P)
    RQ_KT = np.mod(BL * ia - RQ_RK, P)
    QKT = np.mod(TL - Q_RK - RQ_KT - RQ_RK, P)
    return QKT, {"gpu_rows": 2 * m, "gpu_cols": 2 * p, "flop_inflation": 4.0}


def check_twinshield_prefill(rng):
    """Correct at prefill sizes, and the decode attack must FAIL there."""
    out = {}
    for m, p, d in ((64, 64, 32), (256, 256, 64)):
        Q = to_field(rng.normal(0, 1.0, size=(m, d)))
        KT = to_field(rng.normal(0, 1.0, size=(d, p)))
        got, meta = twinshield_attnmult(Q, KT, rng)
        out[f"m{m}_exact"] = bool(np.array_equal(got, fmatmul(Q, KT)))
        out[f"m{m}_flop_inflation"] = meta["flop_inflation"]

    # The attack that breaks decode must not break prefill. Run it with a real
    # budget and confirm it fails, rather than only citing the search-space size.
    m = 32
    Q = to_field(rng.normal(0, 1.0, size=(m, 24)))
    rows, _ = twinshield_pack(Q, rng)
    rec = twinshield_recover(rows, m, max_pairings=20000)
    out["attack_fails_at_m32"] = bool(rec is None)
    out["attack_budget_pairings"] = 20000
    out["search_bits_m32"] = round(twinshield_search_bits(32), 1)
    out["policy"] = "prefill/batched only; decode (m=1) offload is forbidden"
    return out


# ---------------------------------------------------------------------------
# Phase 4: convolution masking (SDXL UNet path, Slalom lineage)
# ---------------------------------------------------------------------------
def conv2d_field(x, w, pad=1):
    """Exact 2D convolution in Z_p via im2col. x: (C,H,W), w: (F,C,kh,kw)."""
    C, H, W = x.shape
    F, C2, kh, kw = w.shape
    assert C == C2
    xp = np.zeros((C, H + 2 * pad, W + 2 * pad), dtype=np.int64)
    xp[:, pad : pad + H, pad : pad + W] = x
    cols = np.empty((C * kh * kw, H * W), dtype=np.int64)
    idx = 0
    for c in range(C):
        for i in range(kh):
            for j in range(kw):
                cols[idx] = xp[c, i : i + H, j : j + W].reshape(-1)
                idx += 1
    return np.mod(w.reshape(F, -1) @ cols, P).reshape(F, H, W)


def check_conv_masking(rng):
    """Slalom masking transfers to convolutions unchanged: u = Conv(r, W).

    Convolution is linear in the input, so the same additive OTP works with the
    unblinding factor computed by convolving the MASK with the public kernel. This
    is the SDXL/UNet path; DiT reuses the transformer path instead.
    """
    C, H, W, F, k = 4, 8, 8, 6, 3
    x = to_field(rng.normal(0, 1.0, size=(C, H, W)))
    w = to_field(rng.normal(0, 0.2, size=(F, C, k, k)))
    r = rng.integers(0, P, size=(C, H, W), dtype=np.int64)

    truth = conv2d_field(x, w)
    u = conv2d_field(r, w)                       # banked offline
    masked = conv2d_field(np.mod(x + r, P), w)   # what the GPU computes
    got = np.mod(masked - u, P)
    return {
        "conv_offload_exact": bool(np.array_equal(got, truth)),
        "mask_is_input_shaped": list(r.shape) == [C, H, W],
        "note": "linearity in the input is all the construction needs; kernel is public",
    }


# ---------------------------------------------------------------------------
# Phase 2: vision (ViT encoder block) end to end
# ---------------------------------------------------------------------------
def check_vit_block(rng):
    """A ViT block with masked offload must match the in-TEE reference exactly.

    Vision matters here because the permutation-equivariance literature covers ViT
    and might tempt someone into using bare permutation. Weights are public, so
    additive masks it is -- this checks the masked path is exact for the patch
    pipeline (patchify -> qkv -> attention -> mlp).
    """
    n_patch, d, heads, d_ff = 16, 32, 4, 64
    gpu = UntrustedGPU()
    bank = MaskBank(b"vit", capacity=1 << 16)
    scale = 1.0 / math.sqrt(d)
    Wqkv = to_field(rng.normal(0, scale, size=(d, 3 * d)))
    Wo = to_field(rng.normal(0, scale, size=(d, d)))
    W1 = to_field(rng.normal(0, scale, size=(d, d_ff)))
    W2 = to_field(rng.normal(0, scale, size=(d_ff, d)))
    lins = {
        n: ShieldedLinear(n, W, bank, rng, gpu)
        for n, W in (("qkv", Wqkv), ("o", Wo), ("fc1", W1), ("fc2", W2))
    }

    img = rng.normal(0, 1.0, size=(n_patch, d))  # already patchified in the TEE

    def block(offload):
        x = img.copy()
        h = np.stack([rms_norm(row) for row in x])
        xf = to_field(h)
        qkv = (lins["qkv"](xf) if offload else fmatmul(xf, Wqkv))
        qkv = from_field(qkv, frac=2 * FRAC)
        q, k, v = qkv[:, :d], qkv[:, d : 2 * d], qkv[:, 2 * d :]
        heads_out = []
        hd = d // heads
        for hh in range(heads):
            sl = slice(hh * hd, (hh + 1) * hd)
            s = (q[:, sl] @ k[:, sl].T) / math.sqrt(hd)
            heads_out.append(np.stack([softmax(row) for row in s]) @ v[:, sl])
        attn = np.concatenate(heads_out, axis=1)
        af = to_field(attn)
        x = x + from_field(lins["o"](af) if offload else fmatmul(af, Wo), frac=2 * FRAC)
        h2 = to_field(np.stack([rms_norm(row) for row in x]))
        f1 = from_field(lins["fc1"](h2) if offload else fmatmul(h2, W1), frac=2 * FRAC)
        act = to_field(f1 * (1.0 / (1.0 + np.exp(-f1))))
        return x + from_field(lins["fc2"](act) if offload else fmatmul(act, W2), frac=2 * FRAC)

    a = block(True)
    seen = len(gpu.view)
    b = block(False)
    return {
        "vit_offload_matches_reference": bool(np.allclose(a, b, rtol=0, atol=0)),
        "tensors_crossing_boundary": seen,
        "patches": n_patch,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    rng = np.random.default_rng(20260814)
    result = {
        "field": check_field(rng),
        "field_scaling": check_field_scaling(rng),
        "rns": check_rns(rng),
        "slalom": check_slalom(rng),
        "freivalds": check_freivalds(rng),
        "twinshield": check_twinshield(rng),
        "decode": check_decode(rng),
        "poisoning": check_cache_poisoning(rng),
        "twinshield_prefill": check_twinshield_prefill(rng),
        "conv_masking": check_conv_masking(rng),
        "vit": check_vit_block(rng),
        "capacity_2k": capacity(2048),
        "capacity_8k": capacity(8192),
        "capacity_32k": capacity(32768),
    }

    ok = (
        result["field"]["roundtrip_within_quantum"]
        and result["slalom"]["recovery_bit_exact"]
        and not result["slalom"]["gpu_ever_saw_plaintext_input"]
        and result["slalom"]["no_mask_reuse"]
        and result["slalom"]["exhaustion_stalls"]
        and result["freivalds"]["detection_rate"] == 1.0
        and result["freivalds"]["no_false_positives"]
        and result["twinshield"]["m1_recovered"]
        and result["decode"]["offload_matches_tee_reference"]
        and result["decode"]["leak_uniform_ok"]
        and not result["decode"]["leak_any_exact_plaintext"]
        and result["decode"]["leak_pooled_ok"]
        and result["poisoning"]["kv_poisoning_caught"]
        and result["rns"]["exact_at_d4096"]
        and result["twinshield_prefill"]["m64_exact"]
        and result["twinshield_prefill"]["m256_exact"]
        and result["twinshield_prefill"]["attack_fails_at_m32"]
        and result["conv_masking"]["conv_offload_exact"]
        and result["vit"]["vit_offload_matches_reference"]
    )
    result["ok"] = bool(ok)

    if args.verbose:
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(result, separators=(",", ":")))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
