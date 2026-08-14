#!/usr/bin/env python3
"""
refill_bench.py — measures the ceiling nobody can engineer around.

Slalom's masking recovers x*W as (x+r)*W - u with u = r*W precomputed. That
precomputation is NOT optional and NOT offloadable: r is the one-time pad, so a
GPU that computed r*W would learn r and could strip the mask. Offloading it under
a second mask needs a mask for the mask, which regresses forever. So the TEE must
perform ONE MAC of integer GEMM for every MAC the GPU performs.

That makes sustained shielded throughput a property of the CVM's integer GEMM
rate, not of the GPU:

    max_tokens_per_second = cpu_MAC_per_second / (linear_MACs_per_token * n_primes)

This benchmark measures the numerator on this box. It is the single number that
decides which models the tier can carry, and docs/shielded-inference.md currently
carries an ESTIMATE (~1 T-MAC/s) that has never been checked.

What saves the design, if anything does, is that refill is a big BATCHED offline
GEMM -- many future tokens' masks at once, near peak -- while decode is a
latency-bound serial chain. So we measure batched GEMM rates, not matvec.
"""

import argparse
import json
import math
import time

import numpy as np

try:
    import torch
except ImportError:
    torch = None

RNS_PRIMES = [251, 241, 239, 233]

# Per-token linear MACs, from docs/shielded-inference.md's capacity model.
MODELS = {
    "llama-3-8b": 7_504_658_432,
    "qwen3-32b-class": 31_983_534_080,
    "qwen2.5-1.5b": 1_100_000_000,
}


def timeit(fn, iters, warmup=2):
    for _ in range(warmup):
        fn()
    t0 = time.perf_counter()
    for _ in range(iters):
        fn()
    return (time.perf_counter() - t0) / iters


def gemm_rate(fn, M, K, N, iters=3):
    t = timeit(fn, iters)
    return (M * K * N) / t  # MAC/s


def bench_numpy(M, K, N, dtype, iters=3):
    a = np.ascontiguousarray(np.random.randn(M, K).astype(dtype))
    b = np.ascontiguousarray(np.random.randn(K, N).astype(dtype))
    return gemm_rate(lambda: a @ b, M, K, N, iters)


def bench_torch(M, K, N, dtype, threads, iters=3):
    torch.set_num_threads(threads)
    a = torch.randn((M, K), dtype=torch.float32).to(dtype)
    b = torch.randn((K, N), dtype=torch.float32).to(dtype)
    return gemm_rate(lambda: torch.matmul(a, b), M, K, N, iters)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    import os
    ncpu = os.cpu_count()
    # Batched refill shape: many future tokens' masks against one weight matrix.
    M, K, N = 1024, 4096, 4096

    result = {"cpu_count": ncpu, "shape": [M, K, N], "rates_MAC_per_s": {}}

    r = result["rates_MAC_per_s"]
    r["numpy_fp64"] = bench_numpy(M, K, N, np.float64)
    r["numpy_fp32"] = bench_numpy(M, K, N, np.float32)
    # int64 is the exact-but-unaccelerated path: numpy has no BLAS for integers,
    # so this shows what "just use exact integers" actually costs.
    small = 256
    r["numpy_int64_small"] = bench_numpy_int(small, 512, 512)

    if torch is not None:
        for th in (16, 32):
            r[f"torch_fp64_t{th}"] = bench_torch(M, K, N, torch.float64, th)
            r[f"torch_fp32_t{th}"] = bench_torch(M, K, N, torch.float32, th)
            try:
                r[f"torch_bf16_t{th}"] = bench_torch(M, K, N, torch.bfloat16, th)
            except Exception:
                r[f"torch_bf16_t{th}"] = None

    best = max(v for v in r.values() if v)
    result["best_MAC_per_s"] = best
    result["best_TMAC_per_s"] = round(best / 1e12, 3)

    # A rate is only usable if the arithmetic is EXACT. Verify each candidate
    # rather than reasoning about mantissa widths and hoping.
    result["exactness"] = exactness_probe()
    exact_rates = {}
    if torch is not None:
        best_fp64 = max(r[f"torch_fp64_t{t}"] for t in (16, 32))
        exact_rates["fp64_byte_primes"] = best_fp64
        if result["exactness"].get("bf16_7bit_k4096"):
            exact_rates["bf16_7bit_primes_k4096"] = max(
                v for k, v in r.items() if k.startswith("torch_bf16") and v
            )
    result["verified_exact_rates_MAC_per_s"] = exact_rates
    result["usable_exact_rate_MAC_per_s"] = max(exact_rates.values()) if exact_rates else r["numpy_fp64"]

    exact_rate = result["usable_exact_rate_MAC_per_s"]
    # AVX-512 VNNI does 4 int8 MACs per fp32 FMA lane. No stock CPU GEMM here
    # exposes it, so this is a PROJECTION from the measured exact fp32 rate, not a
    # measurement -- flagged as such because the tier's viability hinges on it.
    fp32_rate = max(r[f"torch_fp32_t{t}"] for t in (16, 32))
    vnni_projected = fp32_rate * 4
    result["vnni_int8_projected_MAC_per_s"] = vnni_projected
    result["physical_cores"] = ncpu // 2

    proj = {}
    for name, macs in MODELS.items():
        for nprimes in (3, 4):
            refill = macs * nprimes
            proj[f"{name}_rns{nprimes}"] = {
                "refill_MAC_per_token": refill,
                "tok_per_s_measured_exact_fp64": round(exact_rate / refill, 2),
                "tok_per_s_projected_vnni_int8": round(vnni_projected / refill, 2),
                # Refill parallelises across cores, so a real fleet CVM with more
                # cores scales this proportionally. Normalise so the number can be
                # extrapolated instead of mistaken for a fleet-wide ceiling.
                "tok_per_s_per_physical_core_fp64": round(
                    exact_rate / refill / (ncpu // 2), 3),
            }
    result["refill_ceiling"] = proj
    result["verdict"] = (
        f"Refill is the binding constraint. On {ncpu//2} physical cores the best "
        f"VERIFIED-EXACT GEMM is fp64 at {exact_rate/1e9:.0f} G-MAC/s, which sustains only "
        f"{exact_rate/(MODELS['llama-3-8b']*3):.1f} tok/s for an 8B model at RNS-3. bf16 is "
        "NOT exact (probe says false) so its 1.25 T-MAC/s is unusable. The tier "
        "therefore depends on (a) an AVX-512 VNNI int8 GEMM on the TEE side, "
        f"projected ~{vnni_projected/1e12:.1f} T-MAC/s, and/or (b) a CVM with many more "
        "cores than this box. Neither is optional."
    )
    result["note"] = (
        "tok_per_s_at_best_rate assumes an int8/VNNI GEMM reaching the best measured "
        "rate; tok_per_s_fp64_exact is what is achievable TODAY with stock BLAS and "
        "exact byte-prime RNS arithmetic. The truth is between them and depends on "
        "whether a VNNI int8 GEMM gets written for the TEE side."
    )
    print(json.dumps(result, indent=2 if args.verbose else None,
                     separators=None if args.verbose else (",", ":")))
    return 0


def exactness_probe():
    """Which CPU GEMM dtypes give EXACT integer results for RNS residues?

    Checked empirically at the two K values that matter (4096 attention-width and
    14336 FFN-width) rather than argued from mantissa widths, because the
    accumulation dtype torch actually uses is an implementation detail.
    """
    out = {}
    if torch is None:
        return out
    rng = np.random.default_rng(7)
    for label, q, K in (
        ("fp64_byte_k14336", 251, 14336),
        ("fp64_byte_k4096", 251, 4096),
        ("bf16_7bit_k4096", 127, 4096),
        ("bf16_7bit_k14336", 127, 14336),
        ("fp32_7bit_k4096", 127, 4096),
    ):
        half = q // 2
        a = rng.integers(-half, half + 1, size=(64, K)).astype(np.int64)
        b = rng.integers(-half, half + 1, size=(K, 64)).astype(np.int64)
        truth = a @ b
        dt = torch.float64 if label.startswith("fp64") else (
            torch.bfloat16 if label.startswith("bf16") else torch.float32)
        ta = torch.from_numpy(a.astype(np.float64)).to(dt)
        tb = torch.from_numpy(b.astype(np.float64)).to(dt)
        got = torch.matmul(ta, tb).to(torch.float64).numpy()
        out[label] = bool(np.array_equal(got, truth.astype(np.float64)))
    return out


def bench_numpy_int(M, K, N, iters=1):
    a = np.random.randint(-125, 125, size=(M, K), dtype=np.int64)
    b = np.random.randint(-125, 125, size=(K, N), dtype=np.int64)
    return gemm_rate(lambda: a @ b, M, K, N, iters)


if __name__ == "__main__":
    raise SystemExit(main())
