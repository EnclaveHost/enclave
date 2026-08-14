#!/usr/bin/env python3
"""
fused_field_gemm.py — the kernel the report said had to exist.

shielded/REPORT.md ends with one recommendation above all others: fuse the CRT
recombination into the GEMM epilogue, and dequantise weights in-kernel in the same
pass. Those are one piece of work and together they decide two numbers:

  * fused CRT is the difference between 2.7x and 5.3x fp16 at prefill (naive
    recombination costs MORE than the GEMMs and fails the 5x kill criterion), and
  * in-kernel dequantisation is the difference between 6x and ~1x at decode, while
    removing a 5x VRAM inflation that otherwise stops an 8B model fitting an 8 GB
    card at all.

WHAT THIS DOES
--------------
One Triton kernel that, per output tile:
  1. loads PUBLIC weights in their native q8_0 quantised form (1.0625 B/weight),
  2. dequantises and re-encodes them to RNS residues IN REGISTERS (never
     materialising the 3 B/weight field form in VRAM),
  3. multiply-accumulates against the masked activation's residue planes, one
     int32 accumulator per prime,
  4. recombines the residues by Garner CRT in the epilogue and writes ONE int32.

The masking algebra is untouched. This is a representation and scheduling change:
the worker still only ever sees `x + r` (a one-time pad over Z_M) and public
weights, exactly as in docs/shielded-inference.md.

THE DETERMINISM REQUIREMENT (the part that will bite)
-----------------------------------------------------
The TEE computes the unblinding factor u = r*W and the GPU computes (x+r)*W. Those
two must use a BIT-IDENTICAL field encoding of W or the subtraction returns noise.
Dequantisation is floating point, so "both sides do the obvious thing" is not good
enough -- operation order and rounding mode have to match exactly. This module
defines that encoding once, in `encode_weight_fixed`, and the kernel mirrors it
operation for operation:

    d256    = fp32(d_fp16) * 256.0        # exact: 256 is a power of two
    w_fixed = floor(d256 * fp32(q) + 0.5) # one fp32 multiply, then floor

Any future port must use this routine, not reimplement it. `test_encode_matches_kernel`
is the tripwire.

WHAT LIMITED IT, AND WHAT DID NOT
---------------------------------
Two candidate limiters were measured rather than guessed:

  * Scale traffic -- REAL, and the whole gap. The first version loaded the fp16
    scale as a full (BLOCK_K, BLOCK_N) tile, issuing a read per weight for a value
    shared by 32 weights: up to 2 extra bytes per weight against an intended
    0.0625. Loading a (BLOCK_K/32, BLOCK_N) tile and broadcasting in registers took
    decode from 0.90x to 0.70x fp16 and K=14336 to within 16% of the memory roof.
  * Occupancy / split-K -- NOT the limiter. At M=1 the grid is only 32 programs
    against 46 SMs, which looks like the obvious problem, so a split-K variant was
    built (partial int32 accumulators via atomic add, CRT demoted to a second pass
    over M x N). It measured SLOWER: 0.79x vs 0.70x at K=4096 and a wash at
    K=14336. The atomics and the extra launch cost more than the extra parallelism
    buys. Recorded so nobody spends the afternoon rebuilding it.

NOT A PRODUCTION KERNEL. This is a correctness-first Triton implementation; it is
tuned by a correctness-gated sweep on one card (sm_86), not autotuned per shape,
and it does not try to beat cutlass at raw GEMM throughput. What it demonstrates is
the FUSION win and the BANDWIDTH win, both properties of the memory traffic rather
than of the inner loop.
"""

import argparse
import json
import math

import numpy as np
import torch
import triton
import triton.language as tl

# Byte-sized RNS primes: each residue fits one int8 lane, so a field GEMM is N
# GEMMs rather than the N^2 cross-products a single 24-bit prime would need.
Q0, Q1, Q2 = 251, 241, 239
M_MOD = Q0 * Q1 * Q2          # 14,458,349 ~ 2^23.8 of dynamic range
QK = 32                       # q8_0 block size: one fp16 scale per 32 weights
FRAC = 8                      # l = 8 fractional bits, per the design doc

# Garner constants, precomputed on the host (the kernel takes them as scalars).
INV_Q0_MOD_Q1 = pow(Q0 % Q1, -1, Q1)
INV_Q0Q1_MOD_Q2 = pow((Q0 * Q1) % Q2, -1, Q2)


# ---------------------------------------------------------------------------
# The shared encoding. TEE and GPU MUST agree bit-for-bit.
# ---------------------------------------------------------------------------
def encode_weight_fixed(wd_fp16, wq_int8):
    """q8_0 (scale, quant) -> exact fixed-point field integer, as int64.

    THE reference. The Triton kernel mirrors this operation for operation, and
    the TEE-side `u = r*W` precomputation must call this and nothing else.
    """
    d256 = wd_fp16.astype(np.float32) * np.float32(256.0)   # exact
    q = wq_int8.astype(np.float32)
    d256_full = np.repeat(d256, QK, axis=0)[: q.shape[0]]   # broadcast per 32-block
    return np.floor(d256_full * q + np.float32(0.5)).astype(np.int64)


def to_residues(a):
    """Balanced residues mod each prime, int8-safe."""
    out = []
    for q in (Q0, Q1, Q2):
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


# ---------------------------------------------------------------------------
# Kernels
# ---------------------------------------------------------------------------
@triton.jit
def _dequant_to_residues(wq, d256, q0, q1, q2, fast: tl.constexpr):
    """q8_0 -> fixed point -> the residue(s) the accumulators need.

    Mirrors encode_weight_fixed exactly: one fp32 multiply then floor(x + 0.5).

    THE FAST PATH IS THE WHOLE POINT. Only the MASKED ACTIVATION is a large field
    element; the weight in fixed point is tiny (measured max |w_fixed| = 13-68 for
    1/sqrt(K) init at l=8, against a 119 byte-range limit). When it fits a byte,
    w mod q_i == w for every prime, so the weight needs NO RNS decomposition: one
    dequantisation feeds all three channels and six integer modulos per weight
    disappear. Integer `%` costs ~20+ cycles on GPU and the first version of this
    kernel was ALU-bound because of exactly those six.

    `fast` is chosen on the host by `weights_fit_byte`, never guessed here.
    """
    wf = tl.floor(d256 * wq.to(tl.float32) + 0.5).to(tl.int32)
    if fast:
        return wf, wf, wf
    r0 = ((wf % q0) + q0) % q0
    r1 = ((wf % q1) + q1) % q1
    r2 = ((wf % q2) + q2) % q2
    r0 = tl.where(r0 > q0 // 2, r0 - q0, r0)
    r1 = tl.where(r1 > q1 // 2, r1 - q1, r1)
    r2 = tl.where(r2 > q2 // 2, r2 - q2, r2)
    return r0, r1, r2


@triton.jit
def field_gemv_q8_kernel(
    X0, X1, X2,          # masked activation residue planes, (K,) int8
    WQ, WD,              # q8_0 weights: quants (K,N) int8, scales (K/QK,N) fp16
    Y,                   # output (N,) int32, CRT-recombined
    K, N,
    stride_wqk, stride_wqn, stride_wdk, stride_wdn,
    q0: tl.constexpr, q1: tl.constexpr, q2: tl.constexpr,
    inv01: tl.constexpr, inv012: tl.constexpr, mmod: tl.constexpr,
    qk: tl.constexpr, fast: tl.constexpr,
    BLOCK_N: tl.constexpr, BLOCK_K: tl.constexpr,
):
    """Decode path (M=1). Bandwidth-bound, so the whole point is reading 1.0625
    B/weight of q8_0 instead of 3 B/weight of materialised residue planes."""
    pid = tl.program_id(0)
    offs_n = pid * BLOCK_N + tl.arange(0, BLOCK_N)
    mask_n = offs_n < N

    acc0 = tl.zeros((BLOCK_N,), dtype=tl.int32)
    acc1 = tl.zeros((BLOCK_N,), dtype=tl.int32)
    acc2 = tl.zeros((BLOCK_N,), dtype=tl.int32)

    for k0 in range(0, K, BLOCK_K):
        offs_k = k0 + tl.arange(0, BLOCK_K)
        mask_k = offs_k < K

        x0 = tl.load(X0 + offs_k, mask=mask_k, other=0).to(tl.int32)
        x1 = tl.load(X1 + offs_k, mask=mask_k, other=0).to(tl.int32)
        x2 = tl.load(X2 + offs_k, mask=mask_k, other=0).to(tl.int32)

        wptr = WQ + offs_k[:, None] * stride_wqk + offs_n[None, :] * stride_wqn
        wq = tl.load(wptr, mask=mask_k[:, None] & mask_n[None, :], other=0)
        dptr = WD + (offs_k[:, None] // qk) * stride_wdk + offs_n[None, :] * stride_wdn
        d = tl.load(dptr, mask=mask_k[:, None] & mask_n[None, :], other=0.0)
        d256 = d.to(tl.float32) * 256.0

        r0, r1, r2 = _dequant_to_residues(wq, d256, q0, q1, q2, fast)
        acc0 += tl.sum(x0[:, None] * r0, axis=0)
        acc1 += tl.sum(x1[:, None] * r1, axis=0)
        acc2 += tl.sum(x2[:, None] * r2, axis=0)

    # --- fused CRT epilogue (Garner). Intermediates stay inside int32. ---
    a0 = ((acc0 % q0) + q0) % q0
    a1 = ((acc1 % q1) + q1) % q1
    a2 = ((acc2 % q2) + q2) % q2
    t1 = (((a1 - a0) * inv01) % q1 + q1) % q1
    x = a0 + q0 * t1
    t2 = (((a2 - x) * inv012) % q2 + q2) % q2
    x = x + (q0 * q1) * t2
    x = tl.where(x > mmod // 2, x - mmod, x)
    tl.store(Y + offs_n, x, mask=mask_n)


@triton.jit
def field_gemm_q8_kernel(
    X0, X1, X2,          # (M,K) int8 residue planes
    WQ, WD, Y,           # weights + (M,N) int32 output
    M, K, N,
    stride_xm, stride_xk,
    stride_wqk, stride_wqn, stride_wdk, stride_wdn,
    stride_ym, stride_yn,
    q0: tl.constexpr, q1: tl.constexpr, q2: tl.constexpr,
    inv01: tl.constexpr, inv012: tl.constexpr, mmod: tl.constexpr,
    qk: tl.constexpr, fast: tl.constexpr,
    BLOCK_M: tl.constexpr, BLOCK_N: tl.constexpr, BLOCK_K: tl.constexpr,
):
    """Prefill path. tl.dot on int8 hits the tensor cores; the dequantisation and
    the CRT both ride along in the same kernel, so neither costs a memory pass."""
    pid_m = tl.program_id(0)
    pid_n = tl.program_id(1)
    offs_m = pid_m * BLOCK_M + tl.arange(0, BLOCK_M)
    offs_n = pid_n * BLOCK_N + tl.arange(0, BLOCK_N)
    mask_m = offs_m < M
    mask_n = offs_n < N

    acc0 = tl.zeros((BLOCK_M, BLOCK_N), dtype=tl.int32)
    acc1 = tl.zeros((BLOCK_M, BLOCK_N), dtype=tl.int32)
    acc2 = tl.zeros((BLOCK_M, BLOCK_N), dtype=tl.int32)

    NBLK: tl.constexpr = BLOCK_K // qk   # scale rows per K-tile; BLOCK_K % qk == 0

    for k0 in range(0, K, BLOCK_K):
        offs_k = k0 + tl.arange(0, BLOCK_K)
        mask_k = offs_k < K
        xm = mask_m[:, None] & mask_k[None, :]
        xo = offs_m[:, None] * stride_xm + offs_k[None, :] * stride_xk
        x0 = tl.load(X0 + xo, mask=xm, other=0)
        x1 = tl.load(X1 + xo, mask=xm, other=0)
        x2 = tl.load(X2 + xo, mask=xm, other=0)

        wptr = WQ + offs_k[:, None] * stride_wqk + offs_n[None, :] * stride_wqn
        wq = tl.load(wptr, mask=mask_k[:, None] & mask_n[None, :], other=0)

        # ONE scale per 32 weight rows, loaded as a (BLOCK_K/qk, BLOCK_N) tile and
        # broadcast in registers. Loading it per element instead -- which the first
        # version did -- issues an fp16 read for every weight, i.e. 2 extra bytes
        # per weight against an intended 0.0625, and it dominated the decode path.
        offs_b = (k0 // qk) + tl.arange(0, NBLK)
        dblk = tl.load(WD + offs_b[:, None] * stride_wdk + offs_n[None, :] * stride_wdn,
                       mask=(offs_b[:, None] < (K // qk)) & mask_n[None, :], other=0.0)
        d256 = tl.reshape(
            tl.broadcast_to(dblk[:, None, :], (NBLK, qk, BLOCK_N)),
            (BLOCK_K, BLOCK_N)).to(tl.float32) * 256.0

        r0, r1, r2 = _dequant_to_residues(wq, d256, q0, q1, q2, fast)
        w8 = r0.to(tl.int8)
        acc0 += tl.dot(x0, w8, out_dtype=tl.int32)
        acc1 += tl.dot(x1, r1.to(tl.int8), out_dtype=tl.int32)
        acc2 += tl.dot(x2, r2.to(tl.int8), out_dtype=tl.int32)

    a0 = ((acc0 % q0) + q0) % q0
    a1 = ((acc1 % q1) + q1) % q1
    a2 = ((acc2 % q2) + q2) % q2
    t1 = (((a1 - a0) * inv01) % q1 + q1) % q1
    x = a0 + q0 * t1
    t2 = (((a2 - x) * inv012) % q2 + q2) % q2
    x = x + (q0 * q1) * t2
    x = tl.where(x > mmod // 2, x - mmod, x)
    yo = offs_m[:, None] * stride_ym + offs_n[None, :] * stride_yn
    tl.store(Y + yo, x, mask=mask_m[:, None] & mask_n[None, :])


# ---------------------------------------------------------------------------
# Host wrappers
# ---------------------------------------------------------------------------
def weights_fit_byte(w_fixed):
    """Host-side decision for the fast path. A weight whose fixed-point value
    exceeds the byte range would silently wrap in the int8 cast, so this is a
    correctness gate, not a tuning hint."""
    return bool(np.max(np.abs(w_fixed)) <= 119)


def field_gemv_q8(x_res, wq, wd, N, fast=True):
    y = torch.empty((N,), dtype=torch.int32, device="cuda")
    BLOCK_N, BLOCK_K = 256, 128
    grid = (triton.cdiv(N, BLOCK_N),)
    field_gemv_q8_kernel[grid](
        x_res[0], x_res[1], x_res[2], wq, wd, y,
        wq.shape[0], N,
        wq.stride(0), wq.stride(1), wd.stride(0), wd.stride(1),
        Q0, Q1, Q2, INV_Q0_MOD_Q1, INV_Q0Q1_MOD_Q2, M_MOD, QK, fast,
        BLOCK_N=BLOCK_N, BLOCK_K=BLOCK_K, num_warps=8, num_stages=3,
    )
    return y


# ---------------------------------------------------------------------------
# 4-bit weight path
# ---------------------------------------------------------------------------
# Decode is bandwidth-bound, so the dominant term is bytes per weight. q4_0 is
# 0.5625 B/weight against q8_0's 1.0625 -- close to half the traffic.
#
# Packing (ours, not llama.cpp's in-block order; we control both sides):
#   wq4[i, n] low nibble  = weight (i,       n)
#             high nibble = weight (i + K/2, n)      for i in [0, K/2)
# so one byte tile feeds two k-tiles half a K apart and the kernel issues two
# dots per loaded byte. Avoids any nibble interleave.
#
# MEASURED, and worth not re-litigating: the dequantisation strategy does not
# matter. Subtract-then-convert, an FMA-folded bias, and a pure-integer scale all
# land within 3% of each other when measured on an idle card. The ALU is not the
# bottleneck; the byte count is. (Two of those variants first appeared to differ,
# but that was GPU contention -- they returned byte-identical timings, which is
# not something two different kernels do.)
def make_weights_q4(K, N, rng):
    """q4_0-shaped public weight in the split-half packing above."""
    assert K % 64 == 0, "K must be a multiple of 64 for the split-half packing"
    q = rng.integers(0, 16, size=(K, N)).astype(np.uint8)
    scale = (1.0 / math.sqrt(K)) / 8.0 * 4.0
    d = (rng.uniform(0.5, 1.5, size=(K // QK, N)) * scale).astype(np.float16)
    half = K // 2
    return (q[:half] | (q[half:] << 4)).astype(np.uint8), d, q


def encode_weight_fixed_q4(d, q):
    """THE shared encoding for the 4-bit path -- host side of the same contract
    `encode_weight_fixed` provides for q8_0. TEE and GPU must both use this."""
    d256 = d.astype(np.float32) * np.float32(256.0)
    d256_full = np.repeat(d256, QK, axis=0)[: q.shape[0]]
    return np.floor(d256_full * (q.astype(np.float32) - 8.0) + np.float32(0.5)).astype(np.int64)


@triton.jit
def field_gemm_q4_kernel(
    X0, X1, X2, WP, WD, Y, M, K, N,
    sxm, sxk, swpk, swpn, swdk, swdn, sym, syn,
    q0: tl.constexpr, q1: tl.constexpr, q2: tl.constexpr,
    inv01: tl.constexpr, inv012: tl.constexpr, mmod: tl.constexpr, qk: tl.constexpr,
    BLOCK_M: tl.constexpr, BLOCK_N: tl.constexpr, BLOCK_K2: tl.constexpr,
):
    pid_m = tl.program_id(0); pid_n = tl.program_id(1)
    om = pid_m * BLOCK_M + tl.arange(0, BLOCK_M)
    on = pid_n * BLOCK_N + tl.arange(0, BLOCK_N)
    mm = om < M; mn = on < N; half = K // 2
    a0 = tl.zeros((BLOCK_M, BLOCK_N), dtype=tl.int32)
    a1 = tl.zeros((BLOCK_M, BLOCK_N), dtype=tl.int32)
    a2 = tl.zeros((BLOCK_M, BLOCK_N), dtype=tl.int32)
    NB: tl.constexpr = BLOCK_K2 // qk
    for i0 in range(0, half, BLOCK_K2):
        oi = i0 + tl.arange(0, BLOCK_K2); oj = half + oi; mi = oi < half
        pk = tl.load(WP + oi[:, None] * swpk + on[None, :] * swpn,
                     mask=mi[:, None] & mn[None, :], other=0)
        lo = (pk & 0xF).to(tl.int32) - 8
        hi = ((pk >> 4) & 0xF).to(tl.int32) - 8
        bl = (i0 // qk) + tl.arange(0, NB); bh = ((half + i0) // qk) + tl.arange(0, NB)
        dl = tl.load(WD + bl[:, None] * swdk + on[None, :] * swdn,
                     mask=(bl[:, None] < (K // qk)) & mn[None, :], other=0.0).to(tl.float32) * 256.0
        dh = tl.load(WD + bh[:, None] * swdk + on[None, :] * swdn,
                     mask=(bh[:, None] < (K // qk)) & mn[None, :], other=0.0).to(tl.float32) * 256.0
        DL = tl.reshape(tl.broadcast_to(dl[:, None, :], (NB, qk, BLOCK_N)), (BLOCK_K2, BLOCK_N))
        DH = tl.reshape(tl.broadcast_to(dh[:, None, :], (NB, qk, BLOCK_N)), (BLOCK_K2, BLOCK_N))
        wl = tl.floor(DL * lo.to(tl.float32) + 0.5).to(tl.int8)
        wh = tl.floor(DH * hi.to(tl.float32) + 0.5).to(tl.int8)
        xl = om[:, None] * sxm + oi[None, :] * sxk
        xh = om[:, None] * sxm + oj[None, :] * sxk
        xm = mm[:, None] & mi[None, :]
        a0 += tl.dot(tl.load(X0 + xl, mask=xm, other=0), wl, out_dtype=tl.int32)
        a0 += tl.dot(tl.load(X0 + xh, mask=xm, other=0), wh, out_dtype=tl.int32)
        a1 += tl.dot(tl.load(X1 + xl, mask=xm, other=0), wl, out_dtype=tl.int32)
        a1 += tl.dot(tl.load(X1 + xh, mask=xm, other=0), wh, out_dtype=tl.int32)
        a2 += tl.dot(tl.load(X2 + xl, mask=xm, other=0), wl, out_dtype=tl.int32)
        a2 += tl.dot(tl.load(X2 + xh, mask=xm, other=0), wh, out_dtype=tl.int32)
    r0 = ((a0 % q0) + q0) % q0; r1 = ((a1 % q1) + q1) % q1; r2 = ((a2 % q2) + q2) % q2
    t1 = (((r1 - r0) * inv01) % q1 + q1) % q1; x = r0 + q0 * t1
    t2 = (((r2 - x) * inv012) % q2 + q2) % q2; x = x + (q0 * q1) * t2
    x = tl.where(x > mmod // 2, x - mmod, x)
    tl.store(Y + om[:, None] * sym + on[None, :] * syn, x, mask=mm[:, None] & mn[None, :])


def pick_blocks_q4(M):
    """Measured on sm_86, correctness-gated. BLOCK_K2 must be a multiple of QK."""
    if M <= 16:
        return (16, 128, 64, 4, 3)
    return (64, 128, 128, 8, 2)


def field_gemm_q4(x_res, wp, wd, M, K, N):
    bm, bn, bk2, nw, ns = pick_blocks_q4(M)
    y = torch.empty((M, N), dtype=torch.int32, device="cuda")
    field_gemm_q4_kernel[(triton.cdiv(M, bm), triton.cdiv(N, bn))](
        x_res[0], x_res[1], x_res[2], wp, wd, y, M, K, N,
        x_res[0].stride(0), x_res[0].stride(1), wp.stride(0), wp.stride(1),
        wd.stride(0), wd.stride(1), y.stride(0), y.stride(1),
        Q0, Q1, Q2, INV_Q0_MOD_Q1, INV_Q0Q1_MOD_Q2, M_MOD, QK,
        BLOCK_M=bm, BLOCK_N=bn, BLOCK_K2=bk2, num_warps=nw, num_stages=ns)
    return y


def pick_blocks(M):
    """Route by M. Values from a correctness-gated sweep on an RTX 3070 (sm_86);
    every config in that sweep had to reproduce the plaintext product exactly
    before it was allowed to be timed.

    The tensor-core kernel wins even at M=1, where 15 of every 16 rows it computes
    are masked away: a padded tl.dot beats a hand-rolled reduction ~4x because
    decode is bandwidth-bound and the wasted MACs are free. `field_gemv_q8` is kept
    only as the comparison that establishes this.

    BLOCK_M must track M. An earlier table jumped straight from 16 to 64 and cost
    1.75x at M=32, where the kernel computed two rows of padding for every real
    one -- cheap at M=1 where the card is bandwidth-bound, expensive once there is
    real work to displace.

    Returns (BLOCK_M, BLOCK_N, BLOCK_K, num_warps, num_stages). BLOCK_K must be a
    multiple of QK so the scale broadcast divides evenly.
    """
    if M <= 16:
        return (16, 128, 256, 8, 3)      # decode: big BLOCK_K amortises the scale tile
    if M <= 32:
        return (32, 128, 128, 8, 3)
    if M <= 64:
        return (32, 64, 64, 4, 3)
    return (64, 128, 64, 4, 3)           # prefill/batched


def field_gemm(x_res, wq, wd, M, N, fast=True):
    """The entry point. Handles every M, including decode."""
    bm, bn, bk, nw, ns = pick_blocks(M)
    return field_gemm_q8(x_res, wq, wd, M, N, block=(bm, bn, bk), fast=fast,
                         num_warps=nw, num_stages=ns)


def field_gemm_q8(x_res, wq, wd, M, N, block=(64, 128, 64), fast=True,
                  num_warps=4, num_stages=3):
    y = torch.empty((M, N), dtype=torch.int32, device="cuda")
    BM, BN, BK = block
    assert BK % QK == 0, "BLOCK_K must be a multiple of the q8_0 block size"
    grid = (triton.cdiv(M, BM), triton.cdiv(N, BN))
    field_gemm_q8_kernel[grid](
        x_res[0], x_res[1], x_res[2], wq, wd, y,
        M, wq.shape[0], N,
        x_res[0].stride(0), x_res[0].stride(1),
        wq.stride(0), wq.stride(1), wd.stride(0), wd.stride(1),
        y.stride(0), y.stride(1),
        Q0, Q1, Q2, INV_Q0_MOD_Q1, INV_Q0Q1_MOD_Q2, M_MOD, QK, fast,
        BLOCK_M=BM, BLOCK_N=BN, BLOCK_K=BK, num_warps=num_warps, num_stages=num_stages,
    )
    return y


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
def make_weights(K, N, rng):
    """A q8_0-shaped public weight: int8 quants plus one fp16 scale per 32 rows."""
    wq = rng.integers(-127, 128, size=(K, N)).astype(np.int8)
    scale = (1.0 / math.sqrt(K)) / 127.0 * 4.0
    wd = (rng.uniform(0.5, 1.5, size=(K // QK, N)) * scale).astype(np.float16)
    return wq, wd


def make_masked_activation(M, K, rng):
    """Secret activation, its one-time pad, and the masked residue planes."""
    x = np.rint(rng.normal(0, 1.0, size=(M, K)) * (1 << FRAC)).astype(np.int64)
    r = rng.integers(0, M_MOD, size=(M, K)).astype(np.int64)
    masked = np.mod(x + r, M_MOD)
    return x, r, to_residues(masked)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--bench", action="store_true")
    args = ap.parse_args()
    rng = np.random.default_rng(20260814)
    out = {}

    # ---- correctness: end-to-end masked recovery through the fused kernel ----
    def masked_roundtrip(M, K, N, use_gemv):
        wq, wd = make_weights(K, N, rng)
        w_fixed = encode_weight_fixed(wd, wq)
        x, r, res = make_masked_activation(M, K, rng)
        truth = x @ w_fixed                                    # what the TEE wants
        u = np.mod(r @ w_fixed, M_MOD)                         # TEE-side unblinding
        d_wq = torch.from_numpy(wq).cuda()
        d_wd = torch.from_numpy(wd).cuda()
        assert weights_fit_byte(w_fixed), "fast path needs byte-range fixed-point weights"
        if use_gemv:
            d_res = [torch.from_numpy(p[0]).contiguous().cuda() for p in res]
            got = field_gemv_q8(d_res, d_wq, d_wd, N).cpu().numpy().astype(np.int64)
            got = got.reshape(1, N)
        else:
            d_res = [torch.from_numpy(p).contiguous().cuda() for p in res]
            got = field_gemm(d_res, d_wq, d_wd, M, N).cpu().numpy().astype(np.int64)
        y = np.mod(got - u, M_MOD)
        y = np.where(y > M_MOD // 2, y - M_MOD, y)
        return bool(np.array_equal(y, truth)), int(np.max(np.abs(truth)))

    ok_gemv, peak1 = masked_roundtrip(1, 4096, 512, True)
    ok_gemm, peak2 = masked_roundtrip(64, 4096, 256, False)
    out["masked_roundtrip_gemv_exact"] = ok_gemv
    out["masked_roundtrip_gemm_exact"] = ok_gemm
    out["peak_abs_value"] = max(peak1, peak2)
    out["in_range"] = out["peak_abs_value"] < M_MOD // 2

    # ---- the determinism tripwire: kernel encoding == host encoding ----
    wq, wd = make_weights(512, 128, rng)
    w_fixed = encode_weight_fixed(wd, wq)
    ident = np.zeros((1, 512), dtype=np.int64)
    ident[0, 7] = 1  # pick out row 7 => kernel must return w_fixed[7, :] exactly
    res = to_residues(np.mod(ident, M_MOD))
    d_res = [torch.from_numpy(p[0]).contiguous().cuda() for p in res]
    got = field_gemv_q8(d_res, torch.from_numpy(wq).cuda(),
                        torch.from_numpy(wd).cuda(), 128).cpu().numpy().astype(np.int64)
    want = np.mod(w_fixed[7, :], M_MOD)
    want = np.where(want > M_MOD // 2, want - M_MOD, want)
    out["kernel_encoding_matches_host"] = bool(np.array_equal(got, want))

    # ---- 4-bit path: same masked round-trip, half the weight bytes ----
    K4, N4 = 4096, 256
    packed, d4, q4 = make_weights_q4(K4, N4, rng)
    wf4 = encode_weight_fixed_q4(d4, q4)
    x4, r4, res4 = make_masked_activation(1, K4, rng)
    d_res4 = [torch.from_numpy(p).contiguous().cuda() for p in res4]
    got4 = field_gemm_q4(d_res4, torch.from_numpy(packed).cuda(),
                         torch.from_numpy(d4).cuda(), 1, K4, N4).cpu().numpy().astype(np.int64)
    y4 = np.mod(got4 - np.mod(r4 @ wf4, M_MOD), M_MOD)
    y4 = np.where(y4 > M_MOD // 2, y4 - M_MOD, y4)
    out["q4_masked_roundtrip_exact"] = bool(np.array_equal(y4, x4 @ wf4))
    out["q4_weights_fit_byte"] = weights_fit_byte(wf4)

    out["bytes_per_weight"] = {"q8_0_in_kernel": 1 + 2 / QK, "q4_0_in_kernel": 0.5 + 2 / QK,
                               "materialised_rns3": 3, "fp16": 2}
    out["vram_8B_model_GB"] = {
        "q8_0_in_kernel": round(8.03e9 * (1 + 2 / QK) / 1e9, 2),
        "q4_0_in_kernel": round(8.03e9 * (0.5 + 2 / QK) / 1e9, 2),
        "materialised_rns3": round(8.03e9 * 3 / 1e9, 2),
    }

    if args.bench:
        out["bench"] = run_bench(rng)

    out["ok"] = bool(ok_gemv and ok_gemm and out["kernel_encoding_matches_host"]
                     and out["in_range"] and out["q4_masked_roundtrip_exact"])
    print(json.dumps(out, indent=2 if args.verbose else None,
                     separators=None if args.verbose else (",", ":")))
    return 0 if out["ok"] else 1


def run_bench(rng):
    import time

    def t(fn, iters=30, warmup=10):
        for _ in range(warmup):
            fn()
        torch.cuda.synchronize()
        ts = []
        for _ in range(iters):
            t0 = time.perf_counter()
            fn()
            torch.cuda.synchronize()
            ts.append(time.perf_counter() - t0)
        ts.sort()
        return ts[len(ts) // 2] * 1e3

    res = {}
    for (M, K, N) in [(1, 4096, 4096), (1, 14336, 4096), (64, 4096, 4096), (512, 4096, 4096)]:
        wq, wd = make_weights(K, N, rng)
        w_fixed = encode_weight_fixed(wd, wq)
        d_wq, d_wd = torch.from_numpy(wq).cuda(), torch.from_numpy(wd).cuda()
        x, r, planes = make_masked_activation(M, K, rng)
        dr = [torch.from_numpy(p).contiguous().cuda() for p in planes]

        # Never time a kernel without first checking it is right at that shape.
        got = field_gemm(dr, d_wq, d_wd, M, N).cpu().numpy().astype(np.int64)
        y = np.mod(got - np.mod(r @ w_fixed, M_MOD), M_MOD)
        y = np.where(y > M_MOD // 2, y - M_MOD, y)
        exact = bool(np.array_equal(y, x @ w_fixed))

        fp16a = torch.randn((M, K), dtype=torch.float16, device="cuda")
        fp16b = torch.randn((K, N), dtype=torch.float16, device="cuda")
        row = {"exact": exact,
               "fp16_ms": t(lambda: torch.matmul(fp16a, fp16b)),
               "fused_ms": t(lambda: field_gemm(dr, d_wq, d_wd, M, N))}
        row["fused_x_fp16"] = round(row["fused_ms"] / row["fp16_ms"], 2)
        # The fleet serves q4_K (~0.57 B/weight), so fp16 is the flattering
        # denominator. Decode is bandwidth-bound, so scale by the byte ratio:
        # a q4_K baseline would take roughly fp16_ms * 0.57/2.
        row["bytes_per_weight"] = round(1 + 2 / QK, 4)
        row["est_x_q4K"] = round(row["fused_ms"] / (row["fp16_ms"] * 0.57 / 2.0), 2)
        # How close the kernel is to being purely bandwidth-bound: 1.0 would mean
        # it reads its bytes at exactly the rate fp16 reads its own.
        row["bandwidth_efficiency_vs_fp16"] = round(
            (row["bytes_per_weight"] / 2.0) / row["fused_x_fp16"], 2)
        if M == 1:
            drv = [torch.from_numpy(p[0]).contiguous().cuda() for p in planes]
            row["gemv_ms_superseded"] = t(lambda: field_gemv_q8(drv, d_wq, d_wd, N))
        res[f"M{M}_K{K}_N{N}"] = row
    return res


if __name__ == "__main__":
    raise SystemExit(main())
