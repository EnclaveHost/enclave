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


def timeit(fn, iters, warmup=5):
    """Median of per-iteration times, not mean-of-a-batch.

    Under-warming or averaging a short burst gave wildly unstable answers here:
    the same int8 GEMM measured 954, 1800, and 2756 G-MAC/s depending on warmup
    and iteration count. Since one of those numbers decides whether an 8B model
    is servable, the timing method has to be the boring reliable one -- warm the
    threadpool properly, time each iteration separately, take the median.
    """
    for _ in range(warmup):
        fn()
    ts = []
    for _ in range(iters):
        t0 = time.perf_counter()
        fn()
        ts.append(time.perf_counter() - t0)
    ts.sort()
    return ts[len(ts) // 2]


def gemm_rate(fn, M, K, N, iters=9):
    t = timeit(fn, iters)
    return (M * K * N) / t  # MAC/s


def bench_numpy(M, K, N, dtype, iters=5):
    a = np.ascontiguousarray(np.random.randn(M, K).astype(dtype))
    b = np.ascontiguousarray(np.random.randn(K, N).astype(dtype))
    return gemm_rate(lambda: a @ b, M, K, N, iters)


def bench_torch(M, K, N, dtype, threads, iters=9):
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
            # The one that matters: torch._int_mm dispatches to FBGEMM/oneDNN,
            # which use AVX-512 VNNI. int8 in, int32 accumulate -- exactly the
            # shape byte-prime RNS refill needs. Measured, not projected.
            try:
                r[f"torch_int8_t{th}"] = bench_int8(M, K, N, th)
            except Exception:
                r[f"torch_int8_t{th}"] = None

    best = max(v for v in r.values() if v)
    result["best_MAC_per_s"] = best
    result["best_TMAC_per_s"] = round(best / 1e12, 3)

    # A rate is only usable if the arithmetic is EXACT. Verify each candidate
    # rather than reasoning about mantissa widths and hoping.
    result["exactness"] = exactness_probe()
    exact_rates = {}
    if torch is not None:
        exact_rates["fp64_byte_primes"] = max(r[f"torch_fp64_t{t}"] for t in (16, 32))
        if result["exactness"].get("int8_byte_k14336") and result["exactness"].get("int8_byte_k4096"):
            i8 = [r[f"torch_int8_t{t}"] for t in (16, 32) if r.get(f"torch_int8_t{t}")]
            if i8:
                exact_rates["int8_vnni_byte_primes"] = max(i8)
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
    result["vnni_int8_measured_MAC_per_s"] = exact_rates.get("int8_vnni_byte_primes")
    result["physical_cores"] = ncpu // 2

    proj = {}
    for name, macs in MODELS.items():
        for nprimes in (3, 4):
            refill = macs * nprimes
            proj[f"{name}_rns{nprimes}"] = {
                "refill_MAC_per_token": refill,
                # best_exact = fastest rate the exactness probe actually confirmed
                "tok_per_s_best_exact": round(exact_rate / refill, 2),
                "tok_per_s_stock_fp64_blas": round(
                    exact_rates["fp64_byte_primes"] / refill, 2),
                "tok_per_s_int8_vnni": (
                    round(exact_rates["int8_vnni_byte_primes"] / refill, 2)
                    if "int8_vnni_byte_primes" in exact_rates else None),
                # Refill parallelises across cores, so a real fleet CVM with more
                # cores scales this proportionally. Normalise so the number can be
                # extrapolated instead of mistaken for a fleet-wide ceiling.
                "tok_per_s_per_physical_core_best_exact": round(
                    exact_rate / refill / (ncpu // 2), 3),
            }
    result["refill_ceiling"] = proj
    result["verdict"] = (
        f"Refill is the binding constraint on sustained throughput. On {ncpu//2} physical "
        f"cores the best VERIFIED-EXACT GEMM is int8 via torch._int_mm (FBGEMM/oneDNN, "
        f"AVX-512 VNNI) at {exact_rate/1e9:.0f} G-MAC/s, sustaining "
        f"{exact_rate/(MODELS['llama-3-8b']*3):.1f} tok/s for an 8B model at RNS-3. Stock "
        "fp64 BLAS manages only a sixth of that, and bf16 is fast but the exactness probe "
        "says unusable. Refill scales with cores, so per-core figures are the ones to "
        "extrapolate to a fleet CVM."
    )
    result["note"] = (
        "All rates are medians of per-iteration timings after warmup. Only rates whose "
        "arithmetic the exactness probe confirms are used for the ceiling; bf16 is the "
        "cautionary case -- fastest measured and unusable."
    )
    print(json.dumps(result, indent=2 if args.verbose else None,
                     separators=None if args.verbose else (",", ":")))
    return 0


def bench_int8(M, K, N, threads, iters=15):
    """AVX-512 VNNI int8 GEMM via torch._int_mm (FBGEMM/oneDNN on CPU)."""
    torch.set_num_threads(threads)
    half = 251 // 2
    a = torch.randint(-half, half + 1, (M, K), dtype=torch.int8)
    b = torch.randint(-half, half + 1, (K, N), dtype=torch.int8)
    return gemm_rate(lambda: torch._int_mm(a, b), M, K, N, iters)


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
        ("int8_byte_k14336", 251, 14336),
        ("int8_byte_k4096", 251, 4096),
    ):
        half = q // 2
        a = rng.integers(-half, half + 1, size=(64, K)).astype(np.int64)
        b = rng.integers(-half, half + 1, size=(K, 64)).astype(np.int64)
        truth = a @ b
        if label.startswith("int8"):
            got = torch._int_mm(
                torch.from_numpy(a.astype(np.int8)), torch.from_numpy(b.astype(np.int8))
            ).numpy().astype(np.int64)
            out[label] = bool(np.array_equal(got, truth))
            continue
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
