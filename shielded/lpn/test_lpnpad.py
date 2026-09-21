#!/usr/bin/env python3
"""
test_lpnpad.py -- the assertions. `python3 test_lpnpad.py` (no pytest here).

What is proven, and in which ring:
  1. exact unblinding across a full forward pass (greedy generation, growing
     batch each step, so both the B = 1 and the B > 1 paths run) for every
     ring x pad source x public-matrix layout, products bit-identical to the
     in-TEE integer matmul and identical tokens;
  2. exactness at a real layer size (n = m = 4096, the selector's own (k, t))
     at B = 1 and B = 16, in Z_2^32 and the tier's Z_M;
  3. Freivalds catches a lying host, including a 2^(b-1) lie that a ring-mod
     check would miss half the time, and catches a product that wrapped;
  4. pads are fresh: no repeats, and the pads of one layer are linearly
     independent over F_2 (a fixed-basis scheme would fail this);
  5. noise structure: t nonzeros, distinct positions, one per block when
     regular, every value a unit;
  6. the transcript the host sees is uniform-looking (chi-square on a byte);
  7. the selector: constraint honoured, byte-optimal has t > k, flop-optimal
     has t ~ k, a higher target raises k.t, small layers fall back to plain.
"""

import sys
import time

import numpy as np

from lpnpad import (RING_TIER, RING_Z2_24, RING_Z2_32, Freivalds, Host, IntegrityFailure, LPNPads,
                    MaskedLinear, PadRNG, PublicMatrix, ToyTransformer, UniformPads, build_masked_model,
                    plain_linear)
import lpn_select as sel

PASS = 0


def ok(cond, msg):
    global PASS
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)
    PASS += 1
    print(f"  ok  {msg}")


def rank_f2(M):
    """Rank over F_2 of a 0/1 matrix (rows = pads)."""
    M = (np.asarray(M) & 1).astype(np.uint8).copy()
    r = 0
    rows, cols = M.shape
    for c in range(cols):
        piv = None
        for i in range(r, rows):
            if M[i, c]:
                piv = i; break
        if piv is None:
            continue
        M[[r, piv]] = M[[piv, r]]
        for i in range(rows):
            if i != r and M[i, c]:
                M[i] ^= M[r]
        r += 1
        if r == rows:
            break
    return r


def test_forward_pass():
    print("1. exact unblinding across a forward pass")
    model = ToyTransformer(vocab=64, d=64, ff=192, layers=2, heads=4, frac=8, seed=3)
    plain = lambda li, name: plain_linear(model.weight(li, name))
    toks0, prods0 = model.generate([5, 9, 2], 4, plain)
    ok(len(prods0) == 4 * (2 * 4 + 1), "plain run produced every product")
    for ring in (RING_Z2_32, RING_Z2_24, RING_TIER):
        cases = [("uniform", lambda r, W: UniformPads(r, W, PadRNG(seed=11)))]
        for a_mode in PublicMatrix.MODES:
            for regular in (False, True):
                cases.append((f"{'regular-' if regular else ''}lpn/{a_mode}",
                              lambda r, W, a=a_mode, rg=regular: LPNPads(r, W, PadRNG(seed=12), k=16, t=8, regular=rg, a_mode=a)))
        for label, make in cases:
            rec = []
            masked, table, host = build_masked_model(model, ring, make, fv_rng=PadRNG(seed=13), record=rec)
            toks, prods = model.generate([5, 9, 2], 4, masked)
            same = toks == toks0 and len(prods) == len(prods0) and all(np.array_equal(a, b) for a, b in zip(prods0, prods))
            ok(same, f"{ring.name:12s} {label:24s} tokens {toks} == plain, {len(prods)} products bit-identical")
            # the host never saw a plaintext input
            ok(all(not np.array_equal(X, ring.balanced(Xm)) for X, R, Xm in rec), f"{ring.name:12s} {label:24s} host never saw x")


def test_real_size():
    print("2. exactness at a real layer size (selector's own parameters)")
    n = m = 4096
    g = np.random.default_rng(5)
    W = g.integers(-119, 120, size=(m, n), dtype=np.int64)
    for ring, frac in ((RING_Z2_32, 8), (RING_TIER, 3)):
        r = sel.select(n, m, ring_bits=32 if ring.power_of_two else 24, weight_bits=8, batch=1, sec=90)
        k, t = r["k"], r["t"]
        pads = LPNPads(ring, ring.lift(W), PadRNG(seed=21), k=k, t=t, regular=True, a_mode="toeplitz")
        lin = MaskedLinear(ring, W, pads, Host(ring), Freivalds(W, PadRNG(seed=22)))
        for B in (1, 16):
            X = np.rint(g.standard_normal((n, B)) * (1 << frac)).astype(np.int64)
            t0 = time.time(); Y = lin(X); dt = time.time() - t0
            ok(np.array_equal(Y, W @ X), f"{ring.name:12s} n=m={n} k={k} t={t} B={B}: W.x exact ({dt:.2f}s)")


def test_integrity():
    print("3. Freivalds")
    n = m = 256
    g = np.random.default_rng(6)
    W = g.integers(-32, 33, size=(m, n), dtype=np.int64)
    for ring in (RING_Z2_32, RING_TIER):
        host = Host(ring)
        pads = LPNPads(ring, ring.lift(W), PadRNG(seed=31), k=32, t=16)
        lin = MaskedLinear(ring, W, pads, host, Freivalds(W, PadRNG(seed=32)))
        X = g.integers(-256, 257, size=(n, 3), dtype=np.int64)
        ok(np.array_equal(lin(X), W @ X), f"{ring.name}: honest host passes")
        for label, tamper in (("+1 in one entry", lambda Ym: (np.arange(Ym.size).reshape(Ym.shape) == 7).astype(np.int64)),
                              ("+half-ring in one entry", lambda Ym: (np.arange(Ym.size).reshape(Ym.shape) == 7).astype(np.int64) * ring.half)):
            host.tamper = tamper
            caught = False
            try:
                lin(X)
            except IntegrityFailure:
                caught = True
            host.tamper = None
            ok(caught, f"{ring.name}: lie caught ({label})")
        # a wrap: make one product exceed modulus/2
        Xbig = X.copy(); Xbig[:, 0] = 0; Xbig[0, 0] = ring.half // 32 + 1
        wraps = np.any(np.abs(W @ Xbig) > ring.half)
        caught = False
        try:
            lin(Xbig)
        except IntegrityFailure:
            caught = True
        ok(wraps and caught, f"{ring.name}: a product that wrapped the ring is caught (|W.x| > {ring.half})")


def test_freshness_and_structure():
    print("4/5. pad freshness and noise structure")
    n, m = 512, 64
    g = np.random.default_rng(8)
    W = g.integers(-32, 33, size=(m, n), dtype=np.int64)
    for ring in (RING_Z2_32, RING_TIER):
        for regular in (False, True):
            pads = LPNPads(ring, ring.lift(W), PadRNG(seed=41), k=64, t=32, regular=regular)
            Rs = []
            for B in (1, 1, 4, 8, 16):
                R, U = pads.pads(B)
                Rs.append(R)
                ok(np.array_equal(U, ring.matmul(ring.lift(W), R)), f"{ring.name} regular={regular} B={B}: u == W.r")
            R = np.concatenate(Rs, axis=1)           # (n, 30)
            ok(len({tuple(c) for c in R.T}) == R.shape[1], f"{ring.name} regular={regular}: 30 pads, all distinct")
            ok(rank_f2(R.T) == R.shape[1], f"{ring.name} regular={regular}: pads independent over F_2 (rank {R.shape[1]})")
            pos, val = pads.noise(8)
            ok(all(len(set(pos[:, b])) == pads.t for b in range(8)), f"{ring.name} regular={regular}: t distinct positions per pad")
            if regular:
                ok(np.all((pos >= pads.block_lo[:, None]) & (pos < pads.block_hi[:, None])), f"{ring.name}: one position in every block")
            units = np.all(np.gcd(val, ring.modulus) == 1)
            ok(units, f"{ring.name} regular={regular}: every noise value is a unit")


def test_transcript_uniformity():
    print("6. what the host sees")
    ring = RING_Z2_32
    n, m = 1024, 64
    g = np.random.default_rng(9)
    W = g.integers(-32, 33, size=(m, n), dtype=np.int64)
    pads = LPNPads(ring, ring.lift(W), PadRNG(seed=51), k=96, t=48, regular=True)
    rec = []
    lin = MaskedLinear(ring, W, pads, Host(ring), Freivalds(W, PadRNG(seed=52)), record=rec)
    # highly structured inputs: the same small vector every time
    X = np.tile(np.arange(n).reshape(n, 1) % 7, (1, 8))
    for _ in range(4):
        lin(X)
    Xm = np.concatenate([x[2] for x in rec], axis=1)
    lowbyte = (Xm & 0xFF).ravel()
    counts = np.bincount(lowbyte, minlength=256)
    exp = lowbyte.size / 256
    chi2 = float(((counts - exp) ** 2 / exp).sum())
    ok(chi2 < 330, f"low byte of x+r over {lowbyte.size} values: chi-square {chi2:.1f} (255 dof; 330 is p~0.001)")
    corr = abs(np.corrcoef(Xm.ravel().astype(float), np.tile(X, (1, 4)).ravel().astype(float))[0, 1])
    ok(corr < 0.02, f"|corr(x+r, x)| = {corr:.4f}")


def test_selector():
    print("7. selector")
    r = sel.select(16384, 16384, ring_bits=32, weight_bits=4, batch=1, sec=90)
    ok(r["mode"] == "lpn" and r["k"] * r["t"] >= 90 * 16384, f"n=16384 4-bit: lpn k={r['k']} t={r['t']} ratio {r['ratio']:.2f}")
    ok(r["t"] > 2 * r["k"], f"byte objective at 32-bit/4-bit puts t ({r['t']}) well above k ({r['k']})")
    # The handoff says the flop-optimal split is symmetric (k = t). It is not,
    # because computing r = A.s costs n.k multiplies too: on a square layer the
    # flop cost is (2k + t).m, and minimising it under k.t = C gives t = 2k.
    rf = sel.select(16384, 16384, ring_bits=32, weight_bits=4, batch=64, objective="flops", sec=90)
    ok(abs(rf["t"] / rf["k"] - 2.0) < 0.15, f"flop objective on a square layer gives t ~ 2k (A.s counted): k={rf['k']} t={rf['t']} ratio {rf['ratio']:.2f}")
    # And the byte-optimal split equalises the two byte terms: k.rb == t.wb/8,
    # i.e. k/t = wb/rb (the handoff's sqrt(0.5/(b/8)) is a slip).
    ok(abs(r["k"] * 4 - r["t"] * 0.5) / (r["k"] * 4) < 0.05, f"byte objective equalises W.A bytes ({r['wa_bytes']/1e6:.1f} MB) and gathered W bytes ({r['gather_bytes']/1e6:.1f} MB)")
    r150 = sel.select(16384, 16384, ring_bits=32, weight_bits=4, batch=1, sec=150)
    ok(r150["k"] * r150["t"] >= 150 * 16384 and r150["ratio"] > r["ratio"], f"sec=150 costs more: ratio {r150['ratio']:.2f} > {r['ratio']:.2f}")
    rs = sel.select(896, 896, ring_bits=32, weight_bits=8, batch=1, sec=90, a_mode="dense")
    ok(rs["mode"] == "plain", f"n=896 dense A: falls back to plain (ratio {rs['ratio'] if rs.get('ratio') else 'none'})")
    rl3 = sel.select(16384, 16384, ring_bits=16, weight_bits=8, batch=1, sec=90, l3_bytes=16 << 20)
    ok(rl3.get("k_l3") is not None and rl3["wa_bytes_l3"] <= 16 << 20 and rl3["k_l3"] <= rl3["k"], f"L3 point: k={rl3['k_l3']} (unconstrained {rl3['k']})")
    bits = sel.prange_bits(4096, 600, 600)
    ok(abs(bits - 137) < 2, f"handoff calibration: n=4096 k=t=600 -> {bits:.1f} bits")


if __name__ == "__main__":
    t0 = time.time()
    test_forward_pass()
    test_real_size()
    test_integrity()
    test_freshness_and_structure()
    test_transcript_uniformity()
    test_selector()
    print(f"\n{PASS} assertions passed in {time.time() - t0:.1f}s")
