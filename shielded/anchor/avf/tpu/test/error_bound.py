#!/usr/bin/env python3
"""The decode error of a masked digit-split exchange: the analytic bound, then a SIMULATION of it.

READ THIS BEFORE QUOTING A NUMBER FROM IT. Part 1 is a derivation and holds for every exchange this lane
can produce. Part 2 is a NumPy simulation: it uses real weights and real lane widths out of the shipped
bundle, but SYNTHETIC in-lane activations, a subset of layers, and the FIRST projection of each group, and
it models the backend as an ideal rounder. No TPU is invoked and no reply is read. It is therefore evidence
about the arithmetic as designed, and it is NOT a measurement of deployed-kernel error. The deployed number
would have to come from replies captured off the device and compared against the same reference.

--- Part 1: the derivation -------------------------------------------------------------------------------

In output LSBs (everything divided by s_out), with D = DIGIT_OUT_DIV = 102.4, the VM computes

    yhat = (256*a + b)/D - P            a = backend(Wq.hi * M * D),  b = backend(Wq.lo * M * D),
                                        P = round(Wq.r * M)          (minted in the VM, exact integers)

and q = 256*hi + lo exactly (tpu/test/digit-split-test.cpp checks that over the full int16 range), so

    256*(Wq.hi)*M*D + (Wq.lo)*M*D = M*D*(Wq.q).

Write a = A + ea and b = B + eb for the ideal products A, B. Then

    (256a + b)/D = M*(Wq.q) + (256*ea + eb)/D
    yhat         = M*(Wq.(q - r)) + (256*ea + eb)/D - ep

and q - r is the in-lane activation (the wrap and the out-of-lane part are carried exactly by the sparse
correction, which is integer arithmetic and contributes nothing here). So the whole error is

    err = (256*ea + eb)/D - ep,      |ep| <= 1/2.

IDEAL BACKEND (|ea|,|eb| <= 1/2, pure round-half):   |err| <= (256/2 + 1/2)/102.4 + 1/2
                                                            = 128.5/102.4 + 0.5 = 1.7548828125 LSB.

The 256 is digit-split's price: the `hi` digit's rounding is multiplied by 256 on recombination, and D
only buys 102.4 of that back. This term is irreducible for this design -- it is a rounding committed
against the MASKED row, and subtracting an exact pad cannot undo a rounding taken against a different
number.

CONDITIONAL, NOT ESTABLISHED. If the backend's requantisation may additionally deviate from ideal
rounding by up to one unit (|delta| <= 1 on both digits), the same algebra gives

    |err| <= (256*1.5 + 1.5)/102.4 + 0.5 = 4.2646484375 LSB.

That 4.26 figure is CONDITIONAL on the premise |delta| <= 1 GLOBALLY. What was actually observed is
weaker: on two sampled kernels, 5 elements in 117k differed from the reference by exactly 1 LSB and none
by more (TPU.md, "the backend's requantisation is faithful"). That is consistent with |delta| <= 1; it
does not prove it for unsampled layers, activations or pads, and no worst-case production bound should be
quoted from it. Establishing one needs an exhaustive or adversarial characterisation of the backend.

NOT ACCOUNTED FOR HERE, in either part:
  * the float arithmetic the PRODUCTION path uses for the reconstruction and the scaling (this script's
    part 2 reports it separately, but on simulated products, not returned ones);
  * any error in the wrap/out-of-lane correction beyond the exact-integer model above;
  * clipping. A returned rail is a different failure entirely and is handled by the repair; the bound
    above describes an exchange in which nothing clipped.

    python3 tpu/test/error_bound.py [lanes.etpu] [n_groups]
"""

import struct
import sys

import numpy as np

B = sys.argv[1] if len(sys.argv) > 1 else "/home/steven/gguf-e2b/tpu/graphs-h4-ds/lanes.etpu"
NG = int(sys.argv[2]) if len(sys.argv) > 2 else 6
STRIDE = int(sys.argv[3]) if len(sys.argv) > 3 else 23   # sample ACROSS depth, not the first few groups
D = 102.4


def digit_lo(v):
    m = v & 0xFF
    return np.where(m >= 128, m - 256, m)


def digit_hi(v):
    return (v - digit_lo(v)) // 256


def ideal_bound(delta=0.0):
    return (256 * (0.5 + delta) + (0.5 + delta)) / D + 0.5


def one_group(Wq, sig_q, mod, M, s_in, s_out, sw, rng):
    """One exchange, simulated: mask, split, ideal-backend requantise, recombine, unmask, correct."""
    x = rng.integers(-sig_q, sig_q + 1)                      # SYNTHETIC, and deliberately in-lane
    r = rng.integers(-(mod // 2), mod // 2)
    t = x + r
    q = ((t + (mod // 2)) & (mod - 1)) - (mod // 2)
    wrap = t - q                                             # carried exactly by the sparse correction
    hi, lo = digit_hi(q), digit_lo(q)

    a = np.rint((Wq @ hi) * M * D)                           # IDEAL backend: exact product, round-half
    b = np.rint((Wq @ lo) * M * D)
    if np.abs(a).max() >= 32767 or np.abs(b).max() >= 32767:
        return None                                          # a clipped exchange is the repair's business
    P = np.rint((Wq @ r) * M)

    exact = (Wq @ x.astype(np.int64)).astype(np.float64) * M  # the reference, in output LSBs
    f64 = (256.0 * a + b) / D - P
    if wrap.any():
        nz = np.nonzero(wrap)[0]
        f64 = f64 + (Wq[:, nz] @ wrap[nz].astype(np.int64)) * M
    # the same reconstruction in float32, which is what the production path actually evaluates
    s_d = np.float32(s_out) / np.float32(D)
    f32 = (np.float32(s_d) * (np.float32(256.0) * a.astype(np.float32) + b.astype(np.float32))
           - np.float32(s_out) * P.astype(np.float32)) / np.float32(s_out)
    if wrap.any():
        nz = np.nonzero(wrap)[0]
        f32 = f32 + ((Wq[:, nz] @ wrap[nz].astype(np.int64)).astype(np.float32) * M.astype(np.float32))
    return np.abs(f64 - exact), np.abs(f32 - f64)


def main() -> int:
    f = open(B, "rb")
    if f.read(8) != b"ETPUB002":
        print("not a digit-split bundle")
        return 1
    struct.unpack("<I", f.read(4)); f.read(4)
    al8 = lambda o: (o + 7) & ~7  # noqa: E731
    rng = np.random.default_rng(11)

    print(__doc__.split("--- Part 1")[0].strip())
    print(f"\nanalytic bound, ideal backend            : {ideal_bound(0.0):.10f} output LSB")
    print(f"analytic bound IF |backend delta| <= 1   : {ideal_bound(1.0):.10f} output LSB  (CONDITIONAL: "
          f"the premise is not established)\n")

    print(f"{'group':18} {'n_in':>6} {'n_out':>6} {'max err':>9} {'rms err':>9} {'f32 extra':>10}  (output LSB)")
    off, done, gi = 16, 0, 0
    worst = 0.0
    sq_sum, sq_n = 0.0, 0
    f32_worst = 0.0
    while done < NG and off < 1 << 40:
        f.seek(off)
        layer, kind, nproj, n_in = struct.unpack("<HBBI", f.read(8))
        s_in, k = struct.unpack("<ff", f.read(8))
        off += 16
        f.seek(off + n_in * 4)
        sig_q = np.frombuffer(f.read(n_in * 2), np.int16).astype(np.int64)
        r_amp = np.frombuffer(f.read(n_in * 2), np.int16).astype(np.int64)
        off = al8(off + n_in * 8)
        mod = 1 << r_amp
        for pj in range(nproj):
            f.seek(off)
            name = f.read(64).split(b"\0")[0].decode()
            n_out, s_out, budget = struct.unpack("<Ifi", f.read(12))
            take = (done < NG and pj == 0 and gi % STRIDE == 0)
            gi += 1
            if not take:                    # skip the weight blob entirely rather than materialise it
                off = al8(off + 76 + n_out * 4 + n_out * n_in)
                continue
            sw = np.frombuffer(f.read(n_out * 4), np.float32).astype(np.float64)
            Wq = np.frombuffer(f.read(n_out * n_in), np.int8).reshape(n_out, n_in).astype(np.int64)
            off = al8(off + 76 + n_out * 4 + n_out * n_in)
            M = (np.float64(s_in) * sw) / np.float64(s_out)
            got = one_group(Wq, sig_q, mod, M, s_in, s_out, sw, rng)
            if got is None:
                continue
            err, f32d = got
            worst = max(worst, err.max()); f32_worst = max(f32_worst, f32d.max())
            sq_sum += float((err ** 2).sum()); sq_n += err.size
            print(f"blk.{layer:02d}.{kind}.{name[-6:]:8} {n_in:6} {n_out:6} {err.max():9.3f} "
                  f"{np.sqrt((err**2).mean()):9.3f} {f32d.max():10.2e}")
            done += 1

    print(f"\nSIMULATED over {sq_n} elements: max {worst:.3f}, rms {np.sqrt(sq_sum/max(sq_n,1)):.3f} output LSB")
    print(f"  analytic ideal bound {ideal_bound(0.0):.4f} -- {'RESPECTED' if worst <= ideal_bound(0.0) + 1e-9 else 'VIOLATED'}")
    print(f"  float32 reconstruction adds at most {f32_worst:.2e} LSB on top of the f64 model: "
          f"{'negligible' if f32_worst < 1e-2 else 'NOT negligible'}")
    print("\nThis is a simulation with an ideal backend and synthetic in-lane activations, on the first")
    print("projection of groups sampled across the depth of the model. It bounds the DESIGN. It does not measure the deployed kernel, and")
    print("nothing here licenses the conditional 4.26 figure as a production worst case.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
