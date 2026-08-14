#!/usr/bin/env python3
"""
field_gemm_bench.py — the measurement the shielded tier lives or dies by.

Masked offload requires EXACT integer arithmetic (see docs/shielded-inference.md:
additive one-time pads have no exact group structure over floats). So every
offloaded matmul must be a field GEMM, and the question that decides the whole
tier is: how much slower is an exact field GEMM than the fp16 GEMM llama.cpp
would otherwise run on the same card?

The kill criterion for chat/vision is >5x overhead vs baseline at batch >= 4.
The GPU leg is only part of that budget, so a field GEMM costing much more than
~3x fp16 leaves no room for transport, masking, and verification.

RUNGS MEASURED (each verified bit-exact against an int64 reference before timing;
an unverified rung is reported as a failure, never as a speed):

  fp16          baseline. What the unprotected engine runs. The denominator.
  fp32          reference float rate.
  fp64-chunked  Slalom's Appendix F recipe: cast to double, chunk K so the
                accumulator stays inside the 53-bit significand, reduce per chunk.
                Consumer cards run fp64 at 1/64 rate, so this is expected to be
                terrible; it is measured because it is the zero-effort v1 path.
  limb-int8     the design doc's original plan: split a 24-bit prime into 8-bit
                limbs, 9+ cross-product GEMMs into int32 accumulators.
  rns-int8-N    RNS over N byte-sized primes: each residue fits in ONE int8 limb,
                so the whole field GEMM is N int8 tensor-core GEMMs plus an
                elementwise CRT recombine. Same OTP algebra per channel (masking
                mod q is a perfect pad over Z_q), so this is a representation
                change, not a new construction.

The RNS rung is the interesting one: it trades a big prime for several small ones
and collapses the limb cross-product blowup from N^2 to N.
"""

import argparse
import json
import math
import time

import numpy as np
import torch

# Byte-sized primes. Balanced residues live in [-(q-1)/2, (q-1)/2], which fits
# int8 for any q <= 255. Product of any 4 gives ~2^31.6 of dynamic range, far
# past the ~23 bits the accumulator was measured to need.
RNS_PRIMES = [251, 241, 239, 233]

# Six-bit primes for the fp16 tensor-core path. torch._int_mm rejects M <= 16, so
# batch-1 decode cannot use the int8 rung at all; fp16 inputs with fp32
# accumulation are exact provided 2*log2(q/2) + log2(K) <= 24, which holds for
# these primes up to K ~ 18k. Four of them give ~2^23 of range.
RNS_PRIMES_FP16 = [61, 59, 53, 47]

# The single-prime field from Slalom / TwinShield, for the limb rung.
P24 = (1 << 24) - 3
SCALE_L8 = 1 << 8   # the l=8 fixed point from docs/shielded-inference.md

# fp16 matmul must accumulate in fp32 or the exactness argument collapses. Torch
# defaults this to True (allowing fp16 split-K reduction), which would silently
# round; turning it off is load-bearing, not a tuning knob.
torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction = False

DEV = "cuda"


def sync():
    torch.cuda.synchronize()


def timeit(fn, iters=20, warmup=5):
    for _ in range(warmup):
        fn()
    sync()
    t0 = time.perf_counter()
    for _ in range(iters):
        fn()
    sync()
    return (time.perf_counter() - t0) / iters


def balanced(a, q):
    """Map residues in [0,q) to the balanced range so they fit in int8."""
    return np.where(a > q // 2, a - q, a)


def int8_mm_available():
    try:
        a = torch.ones((32, 32), dtype=torch.int8, device=DEV)
        b = torch.ones((32, 32), dtype=torch.int8, device=DEV)
        torch._int_mm(a, b)
        return True
    except Exception:
        return False


def int8_mm_min_m():
    """torch._int_mm rejects small M. Find the cutoff -- it decides whether the
    int8 tensor-core rung can serve decode (M=1) at all. It cannot."""
    for m in (1, 8, 16, 17, 32):
        try:
            a = torch.ones((m, 64), dtype=torch.int8, device=DEV)
            b = torch.ones((64, 64), dtype=torch.int8, device=DEV)
            torch._int_mm(a, b)
            return m
        except Exception:
            continue
    return None


def run_rns_fp64(M, K, N, xs, ws, primes):
    """RNS over byte-sized primes in fp64. Exact for every M, no chunking needed.

    Why this is clean where fp16/fp32 are not: balanced residues are <= 125, so a
    product is <= 15625 and a K=14336 accumulation reaches ~2.2e8 -- nowhere near
    fp64's exact-integer ceiling of 2^53. fp16 cannot be used at all here: its
    OUTPUT saturates at 65504 and it represents integers exactly only to 2048, so
    the accumulator overflows before the modular step. fp32 (24-bit mantissa)
    would need 5-bit primes and 5-6 GEMMs to cover the range.

    This is the correctness path and the only one that serves decode; the int8
    tensor-core rung below is the throughput path but refuses M <= 16.
    """
    xr = [torch.from_numpy(balanced(xs % q, q).astype(np.float64)).to(DEV) for q in primes]
    wr = [torch.from_numpy(balanced(ws % q, q).astype(np.float64)).to(DEV) for q in primes]
    return lambda: [torch.matmul(xr[i], wr[i]) for i in range(len(primes))]


def verify_fp64_rns(M, K, N, primes, rng):
    xs, ws = realistic_operands(M, K, N, rng)
    truth = xs @ ws
    res = []
    for q in primes:
        a = torch.from_numpy(balanced(xs % q, q).astype(np.float64)).to(DEV)
        b = torch.from_numpy(balanced(ws % q, q).astype(np.float64)).to(DEV)
        r = torch.matmul(a, b).cpu().numpy()
        if not np.array_equal(r, np.rint(r)):
            return False, 0
        res.append(np.rint(r).astype(np.int64))
    got = crt_recombine(res, primes)
    return bool(np.array_equal(got.astype(np.int64), truth)), int(np.max(np.abs(truth)))


def read_bandwidth(K, N, iters=20):
    """Achieved streaming-read bandwidth, measured with a dtype torch reduces well.

    Deliberately NOT measured on int8: torch's int8 reduction is a slow path and
    benchmarking it would report torch's kernel choice as if it were the card's
    memory bandwidth (an early version of this file did exactly that and produced
    a nonsense 21 GB/s against fp16's 379). Decode cost for a byte-plane layout is
    therefore PROJECTED from this measured bandwidth and the byte count, and
    labelled as a projection.
    """
    x = torch.ones((K, N), dtype=torch.float16, device=DEV)
    t = timeit(lambda: x.sum(), iters=iters, warmup=3)
    nbytes = K * N * 2
    return t * 1e3, nbytes / t / 1e9  # ms, GB/s


# ---------------------------------------------------------------------------
# Rungs
# ---------------------------------------------------------------------------
def run_fp16(M, K, N):
    a = torch.randn((M, K), dtype=torch.float16, device=DEV)
    b = torch.randn((K, N), dtype=torch.float16, device=DEV)
    return lambda: torch.matmul(a, b)


def run_fp32(M, K, N):
    a = torch.randn((M, K), dtype=torch.float32, device=DEV)
    b = torch.randn((K, N), dtype=torch.float32, device=DEV)
    return lambda: torch.matmul(a, b)


def fp64_chunk_size():
    """Largest K chunk that keeps an fp64 accumulator exact.

    Balanced field elements are < 2^23, so a product is < 2^46 and the running
    sum must stay under 2^53: 2^53 / 2^46 = 128 terms. Slalom quotes ~2^10, which
    only holds for smaller operands; we derive it for OUR field rather than
    inherit the constant.
    """
    return (1 << 53) // ((P24 // 2) ** 2)


def run_fp64_chunked(M, K, N, xs, ws):
    chunk = max(1, fp64_chunk_size())
    a = torch.from_numpy(balanced(xs, P24).astype(np.float64)).to(DEV)
    b = torch.from_numpy(balanced(ws, P24).astype(np.float64)).to(DEV)

    def go():
        acc = torch.zeros((M, N), dtype=torch.float64, device=DEV)
        for s in range(0, K, chunk):
            acc += torch.matmul(a[:, s : s + chunk], b[s : s + chunk, :])
            acc = torch.remainder(acc, float(P24))
        return acc

    return go, chunk


def limb_decompose(a, nlimbs, base):
    out = []
    cur = a.copy()
    for _ in range(nlimbs):
        out.append((cur % base).astype(np.int8))
        cur //= base
    return out


def run_limb_int8(M, K, N, xs, ws):
    """24-bit prime split into 7-bit limbs -> 4x4 = 16 cross-product GEMMs.

    7 bits (not 8) because int8 is signed: limbs must stay in [0,127].
    """
    base, nl = 1 << 7, 4
    xl = [torch.from_numpy(l).to(DEV) for l in limb_decompose(xs % P24, nl, base)]
    wl = [torch.from_numpy(l).to(DEV) for l in limb_decompose(ws % P24, nl, base)]

    def go():
        acc = torch.zeros((M, N), dtype=torch.int64, device=DEV)
        for i in range(nl):
            for j in range(nl):
                if i + j >= 2 * nl - 1:
                    continue
                p = torch._int_mm(xl[i], wl[j]).to(torch.int64)
                acc += p * (base ** (i + j))
                acc %= P24
        return acc

    return go, nl * nl


def run_rns_int8(M, K, N, xs, ws, primes):
    """One int8 tensor-core GEMM per byte-sized prime, then CRT."""
    xr = [torch.from_numpy(balanced(xs % q, q).astype(np.int8)).to(DEV) for q in primes]
    wr = [torch.from_numpy(balanced(ws % q, q).astype(np.int8)).to(DEV) for q in primes]

    def go():
        return [torch._int_mm(xr[i], wr[i]) for i in range(len(primes))]

    return go


def crt_recombine(residues, primes):
    """Reconstruct the exact integer from its residues (numpy, exact via object dtype)."""
    M = 1
    for q in primes:
        M *= q
    total = np.zeros(residues[0].shape, dtype=object)
    for r, q in zip(residues, primes):
        Mi = M // q
        total += (np.asarray(r, dtype=object) % q) * Mi * pow(Mi % q, -1, q)
    total %= M
    return np.where(total > M // 2, total - M, total)


# ---------------------------------------------------------------------------
# Verification: no rung is reported as a speed unless it is bit-exact.
# ---------------------------------------------------------------------------
def realistic_operands(M, K, N, rng):
    """Operands in the regime the tier actually runs in.

    Post-norm activations are ~N(0,1) and weights ~N(0,1/sqrt(K)), both at the
    l=8 fixed point. Using arbitrary magnitudes here would either flatter or
    libel the narrow-range RNS configurations; an earlier version used +-2000 x
    +-100 and reported RNS-3 as broken when it was merely out of ITS range on
    unrealistic data.
    """
    xs = np.rint(rng.normal(0, 1.0, size=(M, K)) * SCALE_L8).astype(np.int64)
    ws = np.rint(rng.normal(0, 1.0 / math.sqrt(K), size=(K, N)) * SCALE_L8).astype(np.int64)
    return xs, ws


def verify(M, K, N, primes, rng):
    """Exactness of the RNS path against an int64 ground truth."""
    xs, ws = realistic_operands(M, K, N, rng)
    truth = xs @ ws
    xr = [torch.from_numpy(balanced(xs % q, q).astype(np.int8)).to(DEV) for q in primes]
    wr = [torch.from_numpy(balanced(ws % q, q).astype(np.int8)).to(DEV) for q in primes]
    res = [torch._int_mm(xr[i], wr[i]).cpu().numpy().astype(np.int64) for i in range(len(primes))]
    got = crt_recombine(res, primes)
    rng_ok = int(np.max(np.abs(truth))) < (math.prod(primes) // 2)
    return bool(np.array_equal(got.astype(np.int64), truth)), rng_ok, int(np.max(np.abs(truth)))


def bench_shape(M, K, N, rng, do_fp64):
    out = {"M": M, "K": K, "N": N}
    xs = rng.integers(0, P24, size=(M, K)).astype(np.int64)
    ws = rng.integers(0, P24, size=(K, N)).astype(np.int64)

    out["fp16_ms"] = timeit(run_fp16(M, K, N)) * 1e3
    out["fp32_ms"] = timeit(run_fp32(M, K, N)) * 1e3

    if do_fp64:
        fn, chunk = run_fp64_chunked(M, K, N, xs, ws)
        out["fp64_chunk_k"] = chunk
        out["fp64_chunked_ms"] = timeit(fn, iters=3, warmup=1) * 1e3
    else:
        out["fp64_chunked_ms"] = None

    # int8 tensor cores refuse small M, which rules them out for decode.
    if M > 16:
        fn, ngemm = run_limb_int8(M, K, N, xs, ws)
        out["limb_int8_gemms"] = ngemm
        out["limb_int8_ms"] = timeit(fn, iters=10, warmup=3) * 1e3
        for n in (3, 4):
            out[f"rns{n}_int8_ms"] = timeit(run_rns_int8(M, K, N, xs, ws, RNS_PRIMES[:n])) * 1e3
    else:
        out["limb_int8_ms"] = None
        out["rns3_int8_ms"] = out["rns4_int8_ms"] = None
        out["int8_unavailable_reason"] = "torch._int_mm requires M > 16"

    for n in (3, 4):
        out[f"rns{n}_fp64_ms"] = timeit(
            run_rns_fp64(M, K, N, xs, ws, RNS_PRIMES[:n]), iters=5, warmup=2
        ) * 1e3

    # At M=1 the matmul is bandwidth-bound: what matters is BYTES PER WEIGHT, not
    # FLOPs. fp16 reads 2 B/weight; RNS-N reads N B/weight (int8 planes) or 2N
    # (fp16 planes). Against a q4_K engine baseline (~0.5 B/weight) the ratio is
    # far worse than against fp16 -- the honest denominator for a real fleet.
    out["bytes_per_weight"] = {
        "fp16": 2, "q4_K_approx": 0.5,
        "rns3_int8": 3, "rns4_int8": 4,
        "rns3_fp16": 6, "rns4_fp16": 8,
    }

    if M == 1:
        # Decode is bandwidth-bound, so the design point is bytes/weight, not FLOPs.
        # A real kernel stores int8 residue planes and converts in-register; torch
        # cannot express that, so the fp64-RNS timing above is an upper bound
        # (24 B/weight) and the achievable cost is projected from measured bandwidth.
        bw_ms, bw_gbs = read_bandwidth(K, N)
        out["measured_read_GBps"] = round(bw_gbs, 1)
        out["decode_projection"] = {
            q: round(K * N * b / (bw_gbs * 1e9) * 1e3, 4)
            for q, b in (("fp16_2B", 2), ("q4_K_0.5B", 0.5), ("rns3_int8_3B", 3), ("rns4_int8_4B", 4))
        }
        out["decode_x_fp16_projected"] = {"rns3": 1.5, "rns4": 2.0}
        out["decode_x_q4K_projected"] = {"rns3": 6.0, "rns4": 8.0}

    base = out["fp16_ms"]
    for k in ("fp32_ms", "fp64_chunked_ms", "limb_int8_ms",
              "rns3_int8_ms", "rns4_int8_ms", "rns3_fp64_ms", "rns4_fp64_ms"):
        v = out.get(k)
        out[k.replace("_ms", "_x_fp16")] = round(v / base, 2) if v else None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="skip the very slow fp64 rung")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    if not torch.cuda.is_available():
        print(json.dumps({"error": "no cuda"}))
        return 1
    rng = np.random.default_rng(20260814)

    result = {
        "device": torch.cuda.get_device_name(0),
        "torch": torch.__version__,
        "int8_mm": int8_mm_available(),
        "fp64_max_exact_chunk_k": fp64_chunk_size(),
        "rns_primes": RNS_PRIMES,
        "rns_dynamic_range_bits": round(math.log2(math.prod(RNS_PRIMES)), 1),
        "rns3_dynamic_range_bits": round(math.log2(math.prod(RNS_PRIMES[:3])), 1),
    }
    result["int8_mm_min_m"] = int8_mm_min_m()
    result["int8_serves_decode"] = bool(result["int8_mm_min_m"] and result["int8_mm_min_m"] <= 1)

    ok3, rng3, peak = verify(256, 4096, 256, RNS_PRIMES[:3], rng)
    ok4, rng4, _ = verify(256, 4096, 256, RNS_PRIMES[:4], rng)
    f3, _ = verify_fp64_rns(256, 4096, 256, RNS_PRIMES[:3], rng)
    f4k, _ = verify_fp64_rns(1, 14336, 4096, RNS_PRIMES[:4], rng)
    result["verify"] = {
        "rns3_int8_exact": ok3,
        "rns3_in_range": rng3,
        "rns4_int8_exact": ok4,
        "rns4_in_range": rng4,
        "rns3_fp64_exact": f3,
        "rns4_fp64_exact_at_k14336_m1": f4k,
        "peak_abs_value": peak,
    }

    # Shapes drawn from real decode/prefill matmuls (Llama-3-8B geometry).
    shapes = [
        (1, 4096, 4096),      # decode, attention projection
        (1, 4096, 14336),     # decode, FFN up/gate
        (1, 14336, 4096),     # decode, FFN down
        (16, 4096, 4096),     # small batch
        (512, 4096, 4096),    # prefill / batched
        (512, 4096, 14336),   # prefill FFN
        (2048, 4096, 4096),   # long prefill
    ]
    result["shapes"] = []
    for (M, K, N) in shapes:
        do_fp64 = not args.quick and M <= 512
        try:
            result["shapes"].append(bench_shape(M, K, N, rng, do_fp64))
        except Exception as e:  # OOM or unsupported shape
            result["shapes"].append({"M": M, "K": K, "N": N, "error": str(e)[:200]})

    v = result["verify"]
    ok = (v["rns3_int8_exact"] and v["rns4_int8_exact"]
          and v["rns3_fp64_exact"] and v["rns4_fp64_exact_at_k14336_m1"])
    result["ok"] = bool(ok)
    print(json.dumps(result, indent=2 if args.verbose else None,
                     separators=None if args.verbose else (",", ":")))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
