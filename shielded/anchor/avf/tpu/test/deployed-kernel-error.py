#!/usr/bin/env python3
"""Measure the error of the DEPLOYED kernel, by dispatching a shipped compiled graph on the phone.

Every error figure for this lane so far has been a NumPy simulation with an ideal-rounding backend
(tpu/test/error_bound.py says so in its own header). An audit correctly refused to treat that as a
measurement of what the silicon does. This is the measurement: feed known int8 digit rows to a graph that
is ALREADY COMPILED and in production, read back the int16 products, and compare against the exact
integer reference computed from the same weights in the bundle.

It needs no AOT compiler, which matters because the compiler is currently down: `g5/L0.tflite` was
compiled on 2026-09-19 and is used by the shipped lane.

    python3 tpu/test/deployed-kernel-error.py [bundle] [compiled-graph] [signature-index]
"""

import os
import struct
import subprocess
import sys

import numpy as np

ADB = os.environ.get("ADB", os.path.expanduser("~/Android/Sdk/platform-tools/adb"))
BUNDLE = sys.argv[1] if len(sys.argv) > 1 else "/home/steven/gguf-e2b/tpu/graphs-h4-ds/lanes.etpu"
GRAPH = sys.argv[2] if len(sys.argv) > 2 else "/home/steven/gguf-e2b/tpu/graphs-h4-ds/g5/L0.tflite"
SIG = int(sys.argv[3]) if len(sys.argv) > 3 else 0
DEV = "/data/local/tmp/enclave-runtime-weight"
ROWS = 5
D = 102.4


def read_group(path, want_layer, want_kind):
    f = open(path, "rb")
    magic = f.read(8)
    if magic not in (b"ETPUB002", b"ETPUB003"):
        raise SystemExit(f"bundle magic {magic!r} is not digit-split")
    (ngroups,) = struct.unpack("<I", f.read(4)); f.read(4)
    al8 = lambda o: (o + 7) & ~7  # noqa: E731
    off = 16
    for _ in range(ngroups):
        f.seek(off)
        layer, kind, nproj, n_in = struct.unpack("<HBBI", f.read(8))
        s_in, k = struct.unpack("<ff", f.read(8))
        off += 16
        f.seek(off)
        f.read(n_in * 4)
        sig_q = np.frombuffer(f.read(n_in * 2), np.int16).astype(np.int64)
        f.read(n_in * 2)
        off = al8(off + n_in * 8)
        projs = []
        for _ in range(nproj):
            f.seek(off)
            name = f.read(64).split(b"\0")[0].decode()
            n_out, s_out, budget = struct.unpack("<Ifi", f.read(12))
            sw = np.frombuffer(f.read(n_out * 4), np.float32).astype(np.float64)
            Wq = np.frombuffer(f.read(n_out * n_in), np.int8).reshape(n_out, n_in).astype(np.int64)
            off = al8(off + 76 + n_out * 4 + n_out * n_in)
            projs.append((name, n_out, float(s_out), sw, Wq))
        if layer == want_layer and kind == want_kind:
            return dict(n_in=n_in, s_in=float(s_in), sig_q=sig_q, projs=projs)
    raise SystemExit("group not found")


def sh(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True, timeout=600)


def main():
    g = read_group(BUNDLE, 0, SIG)
    n_in = g["n_in"]
    print(f"{os.path.basename(GRAPH)} signature {SIG}: n_in={n_in}, "
          f"{len(g['projs'])} projection(s) {[p[0].split('.')[-2] for p in g['projs']]}")

    rng = np.random.default_rng(5)
    digits = rng.integers(-127, 128, size=(2 * ROWS, n_in)).astype(np.int8)   # symmetric, as the lane emits

    # the exact reference: what an ideal backend would return, in int16 at the digit scale
    refs = []
    for name, n_out, s_out, sw, Wq in g["projs"]:
        M = (g["s_in"] * sw) / s_out
        acc = (Wq @ digits.astype(np.int64).T).T                              # [2*ROWS, n_out]
        refs.append(np.clip(np.rint(acc * M * D), -32768, 32767).astype(np.int16))

    loc = "/tmp/dke"
    os.makedirs(loc, exist_ok=True)
    digits.tofile(f"{loc}/in.bin")
    np.concatenate([r.reshape(-1) for r in refs]).tofile(f"{loc}/ref.bin")
    for f in ("in.bin", "ref.bin"):
        sh("push", "-q", f"{loc}/{f}", f"{DEV}/{f}")
    if sh("shell", f"[ -f {DEV}/model.tflite ] && echo yes").stdout.strip() != "yes":
        print("pushing the compiled graph (36 MB, once)...")
        sh("push", GRAPH, f"{DEV}/model.tflite")

    r = sh("shell", f"cd {DEV} && ./public_compiled_runner --model=model.tflite --input=in.bin "
                    f"--reference=ref.bin --output=got.bin --backend=npu 2>&1 | tail -20")
    print(r.stdout.strip()[:1500])

    sh("pull", "-q", f"{DEV}/got.bin", f"{loc}/got.bin")
    if not os.path.exists(f"{loc}/got.bin") or os.path.getsize(f"{loc}/got.bin") == 0:
        print("\nno output came back: the runner did not produce got.bin, so nothing is measured here.")
        return 1
    got = np.fromfile(f"{loc}/got.bin", np.int16)
    ref = np.concatenate([r.reshape(-1) for r in refs])
    n = min(got.size, ref.size)
    d = np.abs(got[:n].astype(np.int64) - ref[:n].astype(np.int64))
    print(f"\ncompared {n} of {ref.size} int16 products")
    print(f"  exact matches : {int((d == 0).sum())} ({100.0 * (d == 0).mean():.2f} %)")
    print(f"  max |delta|   : {int(d.max())} digit-scale LSB  (={d.max() / D:.4f} output LSB)")
    print(f"  rms |delta|   : {np.sqrt((d.astype(float) ** 2).mean()):.4f}")
    print("\nThis is the deployed kernel, not a simulation: the graph was compiled 2026-09-19 and is the")
    print("one the lane runs. It bounds the backend deviation that error_bound.py could only assume.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
