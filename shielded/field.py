#!/usr/bin/env python3
"""
field.py -- the RNS field, and the weight encoding both sides must agree on.

THE POINT OF THIS FILE EXISTING SEPARATELY
-------------------------------------------
docs/shielded-inference.md's determinism requirement is that the TEE's u = r*W and
the GPU's (x+r)*W derive BIT-IDENTICAL field elements from the same q8_0 bytes.
Dequantisation is floating point, so "both sides do the obvious thing" is not good
enough; operation order and rounding have to match exactly.

The obvious way to guarantee that is for both sides to call the same function --
which is what they do. But the TEE runs inside a CPU-only confidential VM, and the
kernel module imports torch and triton at module scope. Importing the GPU half to
get a rounding rule would put CUDA in the enclave's dependency set to serve code
that must never touch a GPU. So the shared arithmetic lives here, in numpy alone,
and both fused_field_gemm.py and tee.py import it.

Any future port -- the C++ ELL backend, the JS guest client in metal/guest/ --
mirrors THIS routine, operation for operation. metal/guest/shielded.mjs already
does, in float32 via Math.fround, and the probe's exactness check is what proves
the two agree across languages rather than by inspection.
"""

import numpy as np

# Byte-sized RNS primes: each residue fits one int8 lane, so a field GEMM is N
# GEMMs rather than the N^2 cross-products a single 24-bit prime would need.
Q0, Q1, Q2 = 251, 241, 239
PRIMES = (Q0, Q1, Q2)
M_MOD = Q0 * Q1 * Q2           # 14457349 ~ 2^23.8 of dynamic range
HALF_M = M_MOD // 2
QK = 32                        # q8_0 block size: one fp16 scale per 32 weights
FRAC = 8                       # l = 8 fractional bits, per the design doc

# The kernel's int8 weight lane. It is exactly min(PRIMES)//2, which is not a
# coincidence: at or below this bound the balanced residue of w mod every prime IS
# w, so the weight needs no RNS decomposition on either side.
WEIGHT_BYTE_LIMIT = min(q // 2 for q in PRIMES)     # 119

# Garner constants, precomputed (the kernel takes them as scalars).
INV_Q0_MOD_Q1 = pow(Q0 % Q1, -1, Q1)
INV_Q0Q1_MOD_Q2 = pow((Q0 * Q1) % Q2, -1, Q2)


def encode_weight_fixed(wd_fp16, wq_int8):
    """q8_0 (scale, quant) -> exact fixed-point field integer, as int64.

    THE reference. The Triton kernel mirrors this operation for operation, and
    the TEE-side `u = r*W` precomputation must call this and nothing else.

        d256    = fp32(d_fp16) * 256.0        # exact: 256 is a power of two
        w_fixed = floor(d256 * fp32(q) + 0.5) # one fp32 multiply, then floor
    """
    d256 = wd_fp16.astype(np.float32) * np.float32(256.0)   # exact
    q = wq_int8.astype(np.float32)
    d256_full = np.repeat(d256, QK, axis=0)[: q.shape[0]]   # broadcast per 32-block
    return np.floor(d256_full * q + np.float32(0.5)).astype(np.int64)


def to_residues(a):
    """Balanced residues mod each prime, int8-safe."""
    out = []
    for q in PRIMES:
        r = np.mod(a, q)
        out.append(np.where(r > q // 2, r - q, r).astype(np.int8))
    return out


def crt_host(r0, r1, r2):
    """Garner reconstruction on the host, for the reference path."""
    x = np.mod(r0.astype(np.int64), Q0)
    t1 = np.mod((np.mod(r1.astype(np.int64), Q1) - x) * INV_Q0_MOD_Q1, Q1)
    x = x + Q0 * t1
    t2 = np.mod((np.mod(r2.astype(np.int64), Q2) - x) * INV_Q0Q1_MOD_Q2, Q2)
    x = x + (Q0 * Q1) * t2
    return np.where(x > M_MOD // 2, x - M_MOD, x)


def balanced(a):
    """Balanced representative of Z_M in (-M/2, M/2]."""
    a = np.asarray(a, dtype=np.int64) % M_MOD
    return np.where(a > HALF_M, a - M_MOD, a)


def weights_fit_byte(w_fixed):
    """Host-side decision for the fast path. A weight whose fixed-point value
    exceeds the byte range would silently wrap in the int8 cast, so this is a
    correctness gate, not a tuning hint."""
    return bool(np.max(np.abs(w_fixed)) <= WEIGHT_BYTE_LIMIT)


def encoding_vectors(n=512, seed=7):
    """A deterministic set of (fp16 scale bits, int8 quant) -> w_fixed triples.

    The cross-language determinism tripwire. metal/guest/shielded.mjs recomputes
    these with its own float32 arithmetic and must reproduce every one; a
    divergence in rounding does not fail loudly at run time, it silently returns
    noise from the unmasking subtraction, so it gets a test that fails loudly here.
    Deliberately includes subnormal and near-limit scales, which real GGUF tensors
    hit and a naive fp16 converter gets wrong.
    """
    rng = np.random.default_rng(seed)
    scales = np.concatenate([
        rng.uniform(0.0005, 0.004, size=n // 2),
        rng.uniform(1e-7, 1e-5, size=n // 4),          # subnormal in fp16
        np.array([0.0, 6.0e-8, 5.96e-8, 6.104e-5, 0.00390625]),
        rng.uniform(1e-6, 1e-4, size=n - n // 2 - n // 4 - 5),
    ]).astype(np.float16)
    quants = rng.integers(-127, 128, size=len(scales)).astype(np.int8)
    wd = scales.reshape(-1, 1)
    wq = np.repeat(quants.reshape(-1, 1), QK, axis=0)[: len(scales) * QK]
    enc = encode_weight_fixed(wd, wq)
    return {
        "half_bits": [int(x) for x in scales.view(np.uint16)],
        "quant": [int(x) for x in quants],
        "w_fixed": [int(enc[i * QK, 0]) for i in range(len(scales))],
    }


if __name__ == "__main__":
    import json as _json
    v = encoding_vectors()
    print(_json.dumps({
        "M_MOD": M_MOD, "HALF_M": HALF_M, "primes": list(PRIMES), "QK": QK,
        "FRAC": FRAC, "WEIGHT_BYTE_LIMIT": WEIGHT_BYTE_LIMIT,
        "residue_identity": WEIGHT_BYTE_LIMIT == min(q // 2 for q in PRIMES),
        "vectors": v,
    }, separators=(",", ":")))
