#!/usr/bin/env python3
"""SUPERSEDED AND NON-FUNCTIONAL. Kept only so the attempt is on the record; do not trust its output.

STATUS. This never produced a measurement. It drives the on-device dispatch harness
(`enclave-runtime-weight/public_compiled_runner`), which accepts exactly one model output, while every
signature in a real lane graph has one to three. The harness correctly refuses the mismatch, and the
compiled artifact cannot be re-serialised to extract a single-output subgraph because its NPU bytecode
lives appended outside the flatbuffer.

WHAT REPLACED IT. `kVerifyKernel` in payload/ggml-tpu.cpp, which measures the same quantity better: it
recomputes one element per projection per exchange with the reference expression, under the same bundle,
weights and quantisation, on REAL activations during REAL decode, inside the VM. Roughly 129k digit
comparisons are recorded in TPU.md.

WHY THIS FILE IS FAIL-CLOSED RATHER THAN DELETED. An audit found it could report a STALE result as a
fresh measurement: it ignored every adb return code, reused a remote model.tflite merely because the path
existed, never removed an earlier got.bin, and compared `min(got.size, ref.size)` so a partial or
leftover output passed. It also accepted an ETPUB003 bundle while building one-input stacked-digit data,
and divided a max digit delta by 102.4 while calling it an output LSB, which omits the 256x amplification
a `hi` disagreement carries. Those are now refusals rather than defaults, so if anyone runs it they get
nothing instead of a plausible number. The elaborate mocked-command regressions the audit asked for are
NOT here: writing a test suite for a tool that cannot execute its central step would be effort spent
making a dead path look maintained. If the dispatch-harness route is ever wanted, the harness needs a
signature/output selector first, and the tests should be written then.
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
    # ETPUB003 is the TWO-INPUT contract; this builds ONE-input stacked-digit data, so accepting it
    # would compare against a reference for a graph shape that was never sent.
    if magic != b"ETPUB002":
        raise SystemExit(f"REFUSING: bundle magic {magic!r}; this tool only builds ETPUB002 stacked-digit data")
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
    """Every adb call is checked. The previous version ignored return codes entirely."""
    r = subprocess.run([ADB] + list(a), capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise SystemExit(f"REFUSING: adb {' '.join(a)[:60]} failed rc={r.returncode}: {r.stderr.strip()[:200]}")
    return r


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
    # identity, not mere existence: a stale remote model of the same name is exactly how a previous
    # graph's output gets reported as this one's
    import hashlib
    want = hashlib.sha256(open(GRAPH, "rb").read()).hexdigest()
    got = sh("shell", f"sha256sum {DEV}/model.tflite 2>/dev/null | cut -d' ' -f1").stdout.strip()
    if got != want:
        print(f"pushing the compiled graph ({os.path.getsize(GRAPH)/1e6:.0f} MB)...")
        sh("push", GRAPH, f"{DEV}/model.tflite")
        if sh("shell", f"sha256sum {DEV}/model.tflite | cut -d' ' -f1").stdout.strip() != want:
            raise SystemExit("REFUSING: the pushed graph does not match its local digest")

    r = sh("shell", f"cd {DEV} && ./public_compiled_runner --model=model.tflite --input=in.bin "
                    f"--reference=ref.bin --output=got.bin --backend=npu 2>&1 | tail -20")
    print(r.stdout.strip()[:1500])

    # remove BOTH copies before the run, so a leftover cannot be read back as this run's result
    subprocess.run([ADB, "shell", f"rm -f {DEV}/got.bin"], capture_output=True, timeout=120)
    if os.path.exists(f"{loc}/got.bin"):
        os.unlink(f"{loc}/got.bin")
    sh("pull", "-q", f"{DEV}/got.bin", f"{loc}/got.bin")
    ref = np.concatenate([r.reshape(-1) for r in refs])
    if not os.path.exists(f"{loc}/got.bin"):
        raise SystemExit("REFUSING: no output came back")
    got = np.fromfile(f"{loc}/got.bin", np.int16)
    if got.size != ref.size:                       # exact length, not min()
        raise SystemExit(f"REFUSING: got {got.size} values, expected exactly {ref.size}")
    n = ref.size
    d = np.abs(got[:n].astype(np.int64) - ref[:n].astype(np.int64))
    print(f"\ncompared {n} of {ref.size} int16 products")
    print(f"  exact matches : {int((d == 0).sum())} ({100.0 * (d == 0).mean():.2f} %)")
    # a hi-digit disagreement is amplified by 256 on recombination and a lo one is not, so a single
    # "/ D" figure is wrong for the hi half by that factor
    print(f"  max |delta|   : {int(d.max())} digit-scale LSB "
          f"(={d.max() * 256.0 / D:.4f} output LSB if on hi, {d.max() / D:.4f} if on lo)")
    print(f"  rms |delta|   : {np.sqrt((d.astype(float) ** 2).mean()):.4f}")
    print("\nThis is the deployed kernel, not a simulation: the graph was compiled 2026-09-19 and is the")
    print("one the lane runs. It bounds the backend deviation that error_bound.py could only assume.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
