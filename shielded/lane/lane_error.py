#!/usr/bin/env python3
"""
lane_error.py -- how narrow can the card's weight lane get?

THE QUESTION THIS ANSWERS
-------------------------
REPORT.md 15.3: a decode token on the 27B spends 24 of its 78 ms streaming
weights, because the cards hold the int8 FIELD ENCODING -- one byte per weight
-- and every token reads all 21.6 GB of it. Halving that byte is the only
remaining term worth more than a few percent. Before anyone writes a CUDA
kernel, an encoder and an AVX-512 refill for a narrower lane, this measures
what the model loses.

THE ENCODING, AND WHY A NARROW LANE NEEDS BLOCK EXPONENTS
---------------------------------------------------------
Today (wasm/ggml-shielded/shielded-field.c): one power-of-two exponent per
OUTPUT COLUMN, chosen so max|w * 2^f| <= 119, and the weight is stored as that
int8. The product is one exact integer dot product.

A 4-bit lane has |w_int| <= 7. Keeping a per-column exponent would throw away
four bits of dynamic range across a whole column, which is far coarser than
the q4_K file itself (4 bits per weight WITHIN a 32-block, with its own
scale). So a narrow lane has to carry a per-BLOCK exponent, and for the field
arithmetic to stay exact that exponent must be a power of two: with
F = max_b f_b the product is

    y = sum_b (block_dot_b << (F - f_b))

which is integer-exact -- left shifts only -- and descales by 2^-F exactly as
today. That is the scheme priced here. The cost against the file is that a
power-of-two block exponent throws away up to one bit relative to q4_K's
arbitrary fp16 block scale.

WHAT IS MEASURED
----------------
For real tensors of the deployed 27B (Q4_K / Q5_K / Q6_K rows dequantized to
f32, which is what the tier's encoder sees), the relative error of W.x against
the f32 product, for each candidate lane. The activation is drawn from a
normal distribution and also from a heavy-tailed one, because real activations
have massive channels and those are what decide the encoding's headroom.

Run: python3 shielded/lane/lane_error.py [--rows 512] [--cols 2048]
"""

import argparse
import os
import sys

import numpy as np

sys.path.insert(0, "/home/steven/Projects/llama.cpp/gguf-py")

BLOCK = 32          # the field encoding's q8_0 block, and the natural exponent block
MODEL = os.environ.get("LANE_MODEL",
                       "/home/steven/Projects/enclave-models/qwen3.8-27b-mtp-q4-vl-gguf/Qwen3.8-27B-UD-Q4_K_XL.gguf")
TENSORS = ["blk.3.attn_output.weight", "blk.3.ffn_down.weight", "blk.10.ffn_gate.weight"]


def pot_exponent(peak, limit):
    """Largest power-of-two scale with peak * 2^f <= limit, as an integer f.
    Mirrors the tier's choice (a power of two is exact in the fp16 block scale
    and leaves the shared encoding byte-identical on both sides)."""
    with np.errstate(divide="ignore"):
        f = np.floor(np.log2(np.where(peak > 0, limit / np.maximum(peak, 1e-30), 1.0)))
    return f.astype(np.int64)


def encode_column(w, limit):
    """Today's lane: one exponent per output column (row of w here), |q| <= limit."""
    peak = np.abs(w).max(axis=1)
    f = pot_exponent(peak, limit)
    q = np.rint(w * np.exp2(f)[:, None])
    q = np.clip(q, -limit, limit)
    return q, f


def encode_block(w, limit, block=BLOCK):
    """A narrow lane: one exponent per (column, block of `block` inputs)."""
    N, K = w.shape
    nb = K // block
    wb = w[:, : nb * block].reshape(N, nb, block)
    peak = np.abs(wb).max(axis=2)
    f = pot_exponent(peak, limit)
    q = np.rint(wb * np.exp2(f)[:, :, None])
    q = np.clip(q, -limit, limit)
    return q, f


def product_column(q, f, x):
    """y = (q . x) * 2^-f, the integer dot product the card computes today."""
    return (q @ x) * np.exp2(-f.astype(np.float64))[:, None]


def product_block(q, f, x, block=BLOCK):
    """The block-exponent product, written the way the kernel would: an exact
    integer accumulation at the column's common exponent, then one descale."""
    N, nb, _ = q.shape
    xb = x[: nb * block].reshape(nb, block, -1)
    dots = np.einsum("nbk,bkm->nbm", q, xb)          # per-block integer dot
    F = f.max(axis=1)                                 # the column's common exponent
    shift = np.exp2((F[:, None] - f).astype(np.float64))   # left shifts, exact
    return (dots * shift[:, :, None]).sum(axis=1) * np.exp2(-F.astype(np.float64))[:, None]


def encode_block_intscale(w, limit, block=BLOCK, scale_bits=16):
    """The same narrow lane, but the per-block scale is an arbitrary INTEGER
    rather than a power of two.

    The field arithmetic stays exact: the product is
        y = sum_b  m_b * (sum_{k in b} x_k * q[k])
    which is integer throughout, descaled once per column by 2^-F. The block
    scale therefore costs nothing in exactness and buys back the bit that
    rounding it to a power of two throws away. m_b is an unsigned integer of
    `scale_bits`; the kernel would multiply each block's dot by it.
    """
    N, K = w.shape
    nb = K // block
    wb = w[:, : nb * block].reshape(N, nb, block)
    peak = np.abs(wb).max(axis=2)
    # One column-wide exponent F puts the largest block at the top of the
    # scale range; every block's own multiplier is then an integer.
    colpeak = peak.max(axis=1)
    F = pot_exponent(colpeak, limit * ((1 << scale_bits) - 1) / (1 << scale_bits) * (1 << (scale_bits - 1)))
    # m_b: the integer that maps this block's quantised value back to w * 2^F
    with np.errstate(divide="ignore", invalid="ignore"):
        m = np.rint(peak * np.exp2(F)[:, None] / limit)
    m = np.clip(m, 1, (1 << scale_bits) - 1)
    q = np.rint(wb * np.exp2(F)[:, None, None] / m[:, :, None])
    q = np.clip(q, -limit, limit)
    return (q, m, F)


def product_block_intscale(enc, x, block=BLOCK):
    q, m, F = enc
    N, nb, _ = q.shape
    xb = x[: nb * block].reshape(nb, block, -1)
    dots = np.einsum("nbk,bkm->nbm", q, xb)
    return (dots * m[:, :, None]).sum(axis=1) * np.exp2(-F.astype(np.float64))[:, None]


def encode_block_affine(w, limit, block=BLOCK, scale_bits=16):
    """An AFFINE narrow lane: w ~ (s_b * q + m_b) * 2^-F, with q in [0, limit],
    and s_b, m_b integers.

    This is the shape the model file already uses (q4_K stores a scale AND a
    minimum per sub-block), and it is what the symmetric lanes above were
    missing: a symmetric code has to spend a level on the sign and cannot sit
    the grid where the weights actually are.

    It stays exact for the masked offload, which is the whole constraint:

        y_j = sum_b [ s_jb * (sum_{k in b} q_jbk * x_k) + m_jb * (sum_{k in b} x_k) ]

    Every term is an integer dot product. The block sums of x are computed once
    per exchange and shared by every output column, so the offset costs one
    extra multiply-add per block per column, not a second pass over the weights.
    """
    N, K = w.shape
    nb = K // block
    wb = w[:, : nb * block].reshape(N, nb, block)
    lo = wb.min(axis=2); hi = wb.max(axis=2)
    colpeak = np.maximum(np.abs(lo), np.abs(hi)).max(axis=1)
    F = pot_exponent(colpeak, (1 << (scale_bits - 2)))
    loF = lo * np.exp2(F)[:, None]; hiF = hi * np.exp2(F)[:, None]
    s = np.rint((hiF - loF) / limit)
    s = np.clip(s, 1, (1 << scale_bits) - 1)
    m = np.rint(loF)
    q = np.rint((wb * np.exp2(F)[:, None, None] - m[:, :, None]) / s[:, :, None])
    q = np.clip(q, 0, limit)
    return (q, s, m, F, block)


def product_block_affine(enc, x):
    q, s, m, F, block = enc
    N, nb, _ = q.shape
    xb = x[: nb * block].reshape(nb, block, -1)
    dots = np.einsum("nbk,bkm->nbm", q, xb)         # integer, per block
    xsum = xb.sum(axis=1)                            # one per block, shared by all columns
    y = (dots * s[:, :, None]).sum(axis=1) + m @ xsum
    return y * np.exp2(-F.astype(np.float64))[:, None]


def rel_err(a, b):
    return float(np.linalg.norm(a - b) / max(np.linalg.norm(b), 1e-30))




def encode_direct_i6(w, limit=119, lane=31, block=BLOCK):
    """The lane as actually shipped: int6 chosen from the FLOAT weights, with a
    reconstruction that is still a valid int8 encoding.

    encode_requant_i6 below shows why this distinction is the whole game. If
    the block multiplier is chosen from the already-rounded int8 BYTES, the
    weight is quantised twice and the error is ~3.5%. Choosing m and q from
    w * 2^F directly rounds once, for ~2.1% -- and m*q is STILL an int8 in
    +-119, so the enclave keeps handing every consumer the same int8 array and
    only the card stores (q6, m).
    """
    N, K = w.shape
    nb = K // block
    F = pot_exponent(np.abs(w).max(axis=1), limit)
    ws = (w * np.exp2(F)[:, None])[:, : nb * block].reshape(N, nb, block)
    peak = np.abs(ws).max(axis=2)
    m = np.maximum(1, np.ceil(peak / lane)).astype(np.int64)
    q = np.clip(np.rint(ws / m[:, :, None]), -lane, lane)
    rec = q * m[:, :, None]
    over = np.abs(rec) > limit
    q = np.where(over, np.sign(q) * np.floor(limit / m[:, :, None]), q)
    rec = q * m[:, :, None]
    return (rec.reshape(N, nb * block), F, float((m == 1).mean()))

def encode_requant_i6(w, limit=119, lane=31, block=BLOCK):
    """THE SHIPPED RULE (shielded-field.c::sh_requantise_rows_i6).

    Not a second encoding of the model: it re-quantises the int8 lane that is
    already there. The int8 encoding picks one power-of-two exponent per output
    column so max|w * 2^F| <= 119; this then takes each 32-block of those
    BYTES, picks the smallest integer m that brings the block inside +-31, and
    replaces each byte by m * round(byte/m), stepping back toward zero if the
    rounding would leave the +-119 lane.

    The point of doing it this way is blast radius: the reconstruction is still
    int8, so the Freivalds vectors, the pad-check vectors, the refill that
    computes W.r, the local fallback and the weight hash all keep taking the
    same array. Only the card stores (q6, m) and only its kernel changes.

    A block whose bytes already fit +-31 takes m = 1 and is LOSSLESS, which on
    real weights is most of them -- the column exponent is sized by the
    column's single largest weight, so a typical block sits well under it.
    """
    N, K = w.shape
    nb = K // block
    F = pot_exponent(np.abs(w).max(axis=1), limit)          # the int8 lane, per column
    b8 = np.clip(np.rint(w * np.exp2(F)[:, None]), -limit, limit)
    blk = b8[:, : nb * block].reshape(N, nb, block)
    amax = np.abs(blk).max(axis=2)
    m = np.maximum(1, np.ceil(amax / lane)).astype(np.int64)
    q = np.clip(np.rint(blk / m[:, :, None]), -lane, lane)
    rec = q * m[:, :, None]
    over = np.abs(rec) > limit                               # rounding overshoot
    q = np.where(over, np.sign(q) * np.floor(limit / m[:, :, None]), q)
    rec = q * m[:, :, None]
    frac_lossless = float((m == 1).mean())
    return (rec.reshape(N, nb * block), F, frac_lossless)


def product_requant_i6(enc, x):
    rec, F, _ = enc
    return (rec @ x) * np.exp2(-F)[:, None]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=512, help="output columns of the weight to sample")
    ap.add_argument("--cols", type=int, default=4096, help="input channels to sample (multiple of 32)")
    ap.add_argument("--batch", type=int, default=8)
    args = ap.parse_args()

    import gguf
    from gguf import quants

    reader = gguf.GGUFReader(MODEL)
    by_name = {t.name: t for t in reader.tensors}
    rng = np.random.default_rng(7)

    print(f"model: {os.path.basename(MODEL)}")
    print(f"{'tensor':28s} {'type':6s} {'lane':22s} {'B/weight':>9s} {'gauss':>10s} {'heavy-tail':>11s}")
    for name in TENSORS:
        t = by_name.get(name)
        if t is None:
            print(f"{name}: absent"); continue
        w = quants.dequantize(t.data, t.tensor_type).astype(np.float32)
        # gguf hands back (N, K) with K contiguous, which is the tier's row-per-output layout
        if w.ndim != 2:
            continue
        N, K = w.shape
        n = min(args.rows, N); k = min(args.cols, K) // BLOCK * BLOCK
        w = np.ascontiguousarray(w[:n, :k]).astype(np.float64)

        # two activation shapes: ordinary, and one with massive channels (the
        # thing the tier's outlier splitting exists for)
        xs = {
            "gauss": rng.standard_normal((k, args.batch)),
            "heavy-tail": rng.standard_normal((k, args.batch)),
        }
        heavy = xs["heavy-tail"]
        heavy[rng.choice(k, size=max(1, k // 256), replace=False)] *= 100.0

        ref = {key: w @ x for key, x in xs.items()}

        req = encode_requant_i6(w)
        dir6 = encode_direct_i6(w)
        rows = [("int8 per column (today)", 1.0 + 2.0 / BLOCK, encode_column(w, 119), product_column),
                (f"int6 REQUANT ({req[2]*100:.0f}% m=1)", 6 / 8 + 2.0 / BLOCK, req, product_requant_i6),
                (f"int6 DIRECT ({dir6[2]*100:.0f}% m=1)", 6 / 8 + 2.0 / BLOCK, dir6, product_requant_i6),
                ("int6 pow2 block",        6 / 8 + 1.0 / BLOCK, encode_block(w, 31), product_block),
                ("int4 pow2 block",        4 / 8 + 1.0 / BLOCK, encode_block(w, 7),  product_block),
                ("int6 INT scale block",   6 / 8 + 2.0 / BLOCK, encode_block_intscale(w, 31), product_block_intscale),
                ("int5 INT scale block",   5 / 8 + 2.0 / BLOCK, encode_block_intscale(w, 15), product_block_intscale),
                ("int4 INT scale block",   4 / 8 + 2.0 / BLOCK, encode_block_intscale(w, 7),  product_block_intscale),
                ("int4 AFFINE block",      4 / 8 + 4.0 / BLOCK, encode_block_affine(w, 15), product_block_affine),
                ("int4 AFFINE 16-block",   4 / 8 + 4.0 / 16,    encode_block_affine(w, 15, block=16), product_block_affine),
                ("int5 AFFINE block",      5 / 8 + 4.0 / BLOCK, encode_block_affine(w, 31), product_block_affine)]
        for lane, bytes_per_w, enc, fn in rows:
            call = (lambda x, e=enc, f=fn: f(*e, x)) if len(enc) == 2 else (lambda x, e=enc, f=fn: f(e, x))
            if fn in (product_block_affine, product_requant_i6):
                call = lambda x, e=enc, f=fn: f(e, x)
            errs = [rel_err(call(xs[key]), ref[key]) for key in ("gauss", "heavy-tail")]
            print(f"{name:28s} {t.tensor_type.name:6s} {lane:22s} {bytes_per_w:9.4f} {errs[0]:10.2e} {errs[1]:11.2e}")
    print("\nB/weight counts the lane plus its exponent (one byte per 32-block for the")
    print("block lanes, one fp16 per 32 for today's). Relative error is against the")
    print("f32 product of the SAME dequantized weights, so it isolates the lane.")


if __name__ == "__main__":
    main()
