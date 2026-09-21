#!/usr/bin/env python3
"""
lpn_select.py -- choose (k, t) for LPN-structured pads, or say "plain matvec".

Given a layer (n inputs, m outputs), the ring width, the weight bit-width the
TEE reads, the batch size and a security target, return the (k, t) that
minimises the right cost -- bytes for a single-token decode, multiplies for a
wide batch -- subject to k.t >= sec.n, and return mode="plain" when the LPN
path would not beat a straight pass over W.

THE SECURITY CONSTRAINT, AND WHAT IT IS NOT
-------------------------------------------
The handoff's rule is (t/n).k >= 90 for ~128-bit security. It is the
first-order form of Prange's information-set decoding: the chance that k
uniformly chosen coordinates are all noise-free is (1 - t/n)^k, so an attacker
expects 1/(1 - t/n)^k trials, i.e. -k.log2(1 - t/n) bits before the cost of a
trial. At (t/n).k = 90 that is ~130 bits; at n = 4096, k = t = 600 it is 137.
Both figures are reported. Three caveats the selector cannot resolve, only
expose (REPORT.md, section 8):
  1. 90 is basic ISD. BJMM-class improvements and dual attacks shave the
     margin; `sec` is a knob for exactly that reason, and 120-150 is the
     conservative range.
  2. The estimate is for F_2. For Z_2^b with unit noise the instance is at
     most as hard as F_2-LPN(n, k, t) (lpnpad.py docstring), so the F_2
     figure is an upper bound on what the ring instance delivers.
  3. Regular noise (one position per block) is the PCG variant and has its
     own literature (Esser-Santini; Carozza-Couteau-Joux), which finds
     regular instances somewhat EASIER in some regimes. Treat `sec` for
     regular LPN as needing more margin, not less.

THE COST MODEL
--------------
Per batch of B pads for one layer (all reads once per batch):
  plain:  bytes = n.m.wb/8                       flops = n.m.B
  lpn:    bytes = m.k.rb/8   (W.A)
                + B.t.m.wb/8                    (gathered columns, one pass
                                                 per pad; see costs())
                + A_bytes                        (dense: n.k.rb/8; dense8:
                                                 n.k; toeplitz: (n+k).rb/8)
          flops = (k.m + t.m + n.k).B
with rb = ring bits, wb = weight bits. The time model is
max(bytes / bandwidth, flops / rate) with per-thread constants measured on
the target box (bench_pads.c prints them); at B = 1 it is the bytes term and
at large B the flops term, which is the handoff's two objectives without a
hand-off point between them. `objective` can force either.

The A.s term is in both costs. The handoff omits it; with a dense ring-width A
it is as many bytes as W.A on a square layer, and that changes the answer at
small n (see --table).
"""

import argparse
import json
import math

RING_BYTES = {16: 2, 24: 3, 32: 4}
A_MODES = ("dense", "dense8", "toeplitz")

# Constants for the time model, measured by bench_pads.c on the EPYC 9115 with
# 8 threads on one CCD: ~68 GB/s DRAM read, and the plain axpy kernel's
# compute-bound rate at B = 64. Only their RATIO matters to the selector (it
# decides where bytes stop binding and multiplies start). Another box, or
# another thread count, should pass its own pair.
DEFAULT_BW_BYTES_PER_S = 65e9
DEFAULT_RATE_MAC_PER_S = 250e9


def prange_bits(n, k, t):
    """-log2 Pr[k random coordinates are noise-free] = -k.log2(1 - t/n)."""
    if t >= n:
        return float("inf")
    return -k * math.log2(1.0 - t / n)


def proxy(n, k, t):
    """The handoff's linear proxy (t/n).k."""
    return k * t / n


def a_bytes(n, k, rb, a_mode):
    if a_mode == "dense":
        return n * k * rb
    if a_mode == "dense8":
        return n * k
    if a_mode == "toeplitz":
        return (n + k - 1) * rb
    raise ValueError(a_mode)


def costs(n, m, k, t, ring_bits, weight_bits, batch, a_mode):
    rb = RING_BYTES[ring_bits]
    wb8 = weight_bits / 8.0
    plain_bytes = n * m * wb8
    plain_flops = n * m * batch
    wa = m * k * rb
    # The gather reads B.t rows: one streaming pass per pad over its own t
    # rows (bench_pads.c's per-pad strategy). Reading each row of the UNION
    # once and touching only the pads with noise on it would cap this at n
    # rows, but that kernel loses to the per-pad one at every B measured (its
    # inner loop has an unpredictable trip count), so the model follows the
    # kernel that wins rather than the one that reads fewer bytes.
    gather = batch * t * m * wb8
    ab = a_bytes(n, k, rb, a_mode)
    lpn_bytes = wa + gather + ab
    lpn_flops = (k * m + t * m + n * k) * batch
    return {
        "plain_bytes": plain_bytes, "plain_flops": plain_flops,
        "lpn_bytes": lpn_bytes, "lpn_flops": lpn_flops,
        "wa_bytes": wa, "gather_bytes": gather, "a_bytes": ab,
    }


def select(n, m, ring_bits=32, weight_bits=8, batch=1, sec=90.0, regular=True,
           a_mode="toeplitz", objective="auto", l3_bytes=None, margin=0.95,
           k_min=64, max_rate=0.5, bw=DEFAULT_BW_BYTES_PER_S, rate=DEFAULT_RATE_MAC_PER_S):
    """Return a dict describing the chosen operating point.

    mode        "lpn" or "plain"
    k, t        the LPN parameters (present even for "plain", as the best LPN
                point found, so a caller can see how far it missed)
    ratio       predicted cost of the chosen LPN point / plain, in the objective
    objective   "bytes" | "flops" | "time" (what "auto" resolved to)
    binding     for "time": which term bound the LPN cost
    k_l3, t_l3  the best point with W.A within l3_bytes, if requested
    """
    if ring_bits not in RING_BYTES:
        raise ValueError("ring_bits in {16, 24, 32}")
    if a_mode not in A_MODES:
        raise ValueError(a_mode)
    n, m, batch = int(n), int(m), int(batch)
    if objective == "auto":
        objective = "bytes" if batch == 1 else "time"

    def score(c):
        if objective == "bytes":
            return c["lpn_bytes"], c["plain_bytes"], "bytes"
        if objective == "flops":
            return c["lpn_flops"], c["plain_flops"], "flops"
        lb, lf = c["lpn_bytes"] / bw, c["lpn_flops"] / rate
        pb, pf = c["plain_bytes"] / bw, c["plain_flops"] / rate
        return max(lb, lf), max(pb, pf), ("bytes" if lb >= lf else "flops")

    best = None
    best_l3 = None
    t_max = int(max_rate * n)
    for k in range(max(1, k_min), n + 1):
        t = int(math.ceil(sec * n / k))
        if t > t_max:
            continue                         # noise rate too high to mean anything
        if t < 1:
            t = 1
        c = costs(n, m, k, t, ring_bits, weight_bits, batch, a_mode)
        s, p, binding = score(c)
        cand = {"k": k, "t": t, "score": s, "plain": p, "binding": binding, **c}
        if best is None or s < best["score"]:
            best = cand
        if l3_bytes is not None and c["wa_bytes"] <= l3_bytes and (best_l3 is None or s < best_l3["score"]):
            best_l3 = cand
    out = {"n": n, "m": m, "ring_bits": ring_bits, "weight_bits": weight_bits, "batch": batch,
           "sec": sec, "regular": regular, "a_mode": a_mode, "objective": objective}
    if best is None:
        out.update(mode="plain", reason=f"no (k, t) with k.t >= {sec}.n and t <= {max_rate}.n", ratio=None)
        return out
    ratio = best["score"] / best["plain"]
    out.update(k=best["k"], t=best["t"], noise_rate=best["t"] / n,
               bits_prange=prange_bits(n, best["k"], best["t"]), proxy=proxy(n, best["k"], best["t"]),
               ratio=ratio, binding=best["binding"],
               plain_bytes=best["plain_bytes"], lpn_bytes=best["lpn_bytes"],
               plain_flops=best["plain_flops"], lpn_flops=best["lpn_flops"],
               wa_bytes=best["wa_bytes"], gather_bytes=best["gather_bytes"], a_bytes=best["a_bytes"],
               mode="lpn" if ratio < margin else "plain")
    if out["mode"] == "plain":
        out["reason"] = f"LPN at {ratio:.2f}x of plain in {objective}; margin {margin}"
    if l3_bytes is not None:
        if best_l3 is not None:
            out.update(k_l3=best_l3["k"], t_l3=best_l3["t"], ratio_l3=best_l3["score"] / best_l3["plain"],
                       wa_bytes_l3=best_l3["wa_bytes"])
        else:
            out.update(k_l3=None, reason_l3=f"no (k, t) keeps W.A within {l3_bytes} bytes")
    return out


def closed_form(n, m, ring_bits, weight_bits, sec, a_mode):
    """The handoff's continuous optimum for B = 1 bytes, for comparison.
    Minimise k.(m.rb + A'(k)) + (sec.n/k).m.wb/8 over k."""
    rb = RING_BYTES[ring_bits]
    wb8 = weight_bits / 8.0
    a_per_k = {"dense": n * rb, "dense8": n, "toeplitz": 0.0}[a_mode]
    k = math.sqrt(sec * n * m * wb8 / (m * rb + a_per_k))
    return k, sec * n / k


SHAPES = {
    # the handoff's worked examples
    "spec-4096": (4096, 4096), "spec-16384": (16384, 16384),
    # real layers this tier serves (blk.0 of the GGUFs on this box; n = inputs)
    "27b-qkv": (5120, 10240), "27b-gateup": (5120, 2 * 17408), "27b-down": (17408, 5120),
    "27b-ssm_out": (6144, 5120), "27b-lm_head": (5120, 248320),
    "9b-qkv": (4096, 8192), "9b-gateup": (4096, 2 * 12288), "9b-down": (12288, 4096),
    "0.5b-gateup": (896, 2 * 4864), "0.5b-down": (4864, 896),
}


def table(args):
    rows = []
    for name, (n, m) in SHAPES.items():
        for B in (1, 8, 64):
            r = select(n, m, ring_bits=args.ring, weight_bits=args.wbits, batch=B, sec=args.sec,
                       a_mode=args.a_mode, l3_bytes=args.l3)
            rows.append((name, n, m, B, r))
    print(f"ring {args.ring}-bit, weights {args.wbits}-bit, A={args.a_mode}, sec={args.sec}")
    print(f"{'layer':14s} {'n':>6s} {'m':>7s} {'B':>3s} {'mode':6s} {'k':>5s} {'t':>5s} {'t/n':>6s} {'bits':>6s} {'obj':6s} {'ratio':>6s} {'WA MB':>7s}")
    for name, n, m, B, r in rows:
        if r.get("k") is None:
            print(f"{name:14s} {n:6d} {m:7d} {B:3d} {r['mode']:6s} {'-':>5s} {'-':>5s}")
            continue
        print(f"{name:14s} {n:6d} {m:7d} {B:3d} {r['mode']:6s} {r['k']:5d} {r['t']:5d} {r['noise_rate']:6.3f} "
              f"{r['bits_prange']:6.1f} {r['objective']:6s} {r['ratio']:6.2f} {r['wa_bytes']/1e6:7.1f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--n", type=int); ap.add_argument("--m", type=int)
    ap.add_argument("--ring", type=int, default=32, choices=(16, 24, 32))
    ap.add_argument("--wbits", type=int, default=8, help="weight bits the TEE reads (this tier: 8; the handoff: 4)")
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--sec", type=float, default=90.0, help="(t/n).k target; 90 = basic ISD, raise to 120-150 for margin")
    ap.add_argument("--a-mode", default="toeplitz", choices=A_MODES)
    ap.add_argument("--objective", default="auto", choices=("auto", "bytes", "flops", "time"))
    ap.add_argument("--l3", type=float, default=None, help="L3 budget in bytes for W.A (reports a second point)")
    ap.add_argument("--random", action="store_true", help="random noise positions rather than regular")
    ap.add_argument("--table", action="store_true", help="print the handoff's shapes and this tier's layers")
    args = ap.parse_args()
    if args.table:
        return table(args)
    if args.n is None or args.m is None:
        ap.error("--n and --m, or --table")
    r = select(args.n, args.m, ring_bits=args.ring, weight_bits=args.wbits, batch=args.batch, sec=args.sec,
               regular=not args.random, a_mode=args.a_mode, objective=args.objective, l3_bytes=args.l3)
    k, t = closed_form(args.n, args.m, args.ring, args.wbits, args.sec, args.a_mode)
    r["closed_form_k"], r["closed_form_t"] = k, t
    print(json.dumps(r, indent=2))


if __name__ == "__main__":
    main()
