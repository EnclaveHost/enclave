"""probe_digitcombine.py -- recombine the digit split ON THE TPU, without the op that crashes the compiler.

The shipped lane sends a masked int16 row as two int8 digits (q = 256*hi + lo), as ROWS of one input,
and gets back TWO int16 products the VM recombines -- so the reply, the largest thing crossing the pVM
boundary, is doubled. Recombining on the TPU was blocked because saying "take the hi rows and the lo
rows and add them" needs SLICE, which the G5 compiler crashes on.

It does not need SLICE if hi and lo arrive as SEPARATE INPUTS. Then: one FULLY_CONNECTED per digit
against ONE shared weight buffer -- referenced by two tensors whose per-channel scales differ by exactly
256 -- and an ADD. The TPU returns W.q directly, one int16 row per logical row.

Builds, at the real shape with int8 weights (the shipped a8w8):
  split    the SHIPPED construction: one input [2R, n_in] (hi/lo interleaved), one FC, [2R, n_out] out
  combine  two inputs [R, n_in] each, two FCs on one shared buffer at scales s*256 and s, ADD -> [R, n_out]
"""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_groupwise import Graph            # the same author-it-directly builder
from ai_edge_litert import schema_py_generated as S

N_IN, N_OUT, R = 2048, 8192, 5
S_ACT = 0.01
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dc")

def weights():
    return np.random.default_rng(7).integers(-127, 128, size=(N_OUT, N_IN), dtype=np.int8)

def wscale():
    return (0.00002 * (1.0 + 0.1 * np.random.default_rng(8).random(N_OUT))).astype(np.float32)

def build(mode):
    W = weights(); s = wscale(); g = Graph(); fo = S.FullyConnectedOptionsT(); fo.keepNumDims = True
    os.makedirs(OUT, exist_ok=True); p = os.path.join(OUT, f"{mode}.tflite")
    if mode == "split":
        # the digit products each span a fraction of the full range; their output scale is set for that
        s_dig = np.float32(0.004)
        x = g.tensor("x", S.TensorType.INT8, [2 * R, N_IN], np.float32(S_ACT))
        w = g.tensor("w", S.TensorType.INT8, [N_OUT, N_IN], s, W.tobytes())
        y = g.tensor("y", S.TensorType.INT16, [2 * R, N_OUT], s_dig)
        g.op(S.BuiltinOperator.FULLY_CONNECTED, [x, w, -1], [y], S.BuiltinOptions.FullyConnectedOptions, fo)
        return p, g.finish(p, [x], y), dict(s_out=float(s_dig))
    # combine: the full-range output needs the full-range scale -- 256x the hi digit's contribution
    s_full = np.float32(0.004 * 256 / 1.0)
    xh = g.tensor("x_hi", S.TensorType.INT8, [R, N_IN], np.float32(S_ACT))
    xl = g.tensor("x_lo", S.TensorType.INT8, [R, N_IN], np.float32(S_ACT))
    buf = W.tobytes()
    wh = g.tensor("w_hi", S.TensorType.INT8, [N_OUT, N_IN], s * np.float32(256.0), buf)
    wl = g.tensor("w_lo", S.TensorType.INT8, [N_OUT, N_IN], s, buf)
    yh = g.tensor("y_hi", S.TensorType.INT16, [R, N_OUT], s_full)
    yl = g.tensor("y_lo", S.TensorType.INT16, [R, N_OUT], s_full)
    y = g.tensor("y", S.TensorType.INT16, [R, N_OUT], s_full)
    g.op(S.BuiltinOperator.FULLY_CONNECTED, [xh, wh, -1], [yh], S.BuiltinOptions.FullyConnectedOptions, fo)
    g.op(S.BuiltinOperator.FULLY_CONNECTED, [xl, wl, -1], [yl], S.BuiltinOptions.FullyConnectedOptions, fo)
    g.op(S.BuiltinOperator.ADD, [yh, yl], [y], S.BuiltinOptions.AddOptions, S.AddOptionsT())
    return p, g.finish(p, [xh, xl], y), dict(s_out=float(s_full))


def build_shared(mode):
    """combine_in:  ONE weight tensor used by BOTH FCs; the 256 rides on the hi INPUT's scale instead.
                    256*S_ACT*s*W.hi + S_ACT*s*W.lo = S_ACT*s*W.q -- same maths, and there is nothing to
                    duplicate because there is only one weight tensor.
       combine_buf: two weight TENSORS on one shared BUFFER index at scales s*256 and s -- does the compiler
                    keep one copy of the bytes when only the quantisation parameters differ?"""
    W = weights(); s = wscale(); g = Graph(); fo = S.FullyConnectedOptionsT(); fo.keepNumDims = True
    s_full = np.float32(0.004 * 256)
    p = os.path.join(OUT, f"{mode}.tflite")
    if mode == "combine_in":
        xh = g.tensor("x_hi", S.TensorType.INT8, [R, N_IN], np.float32(S_ACT * 256.0))
        xl = g.tensor("x_lo", S.TensorType.INT8, [R, N_IN], np.float32(S_ACT))
        w = g.tensor("w", S.TensorType.INT8, [N_OUT, N_IN], s, W.tobytes())
        wh = wl = w
    else:
        xh = g.tensor("x_hi", S.TensorType.INT8, [R, N_IN], np.float32(S_ACT))
        xl = g.tensor("x_lo", S.TensorType.INT8, [R, N_IN], np.float32(S_ACT))
        wh = g.tensor("w_hi", S.TensorType.INT8, [N_OUT, N_IN], s * np.float32(256.0), W.tobytes())
        wl = g.tensor("w_lo", S.TensorType.INT8, [N_OUT, N_IN], s)          # no data yet ...
        g.sg.tensors[wl].buffer = g.sg.tensors[wh].buffer                    # ... it shares w_hi's buffer
    yh = g.tensor("y_hi", S.TensorType.INT16, [R, N_OUT], s_full)
    yl = g.tensor("y_lo", S.TensorType.INT16, [R, N_OUT], s_full)
    y = g.tensor("y", S.TensorType.INT16, [R, N_OUT], s_full)
    g.op(S.BuiltinOperator.FULLY_CONNECTED, [xh, wh, -1], [yh], S.BuiltinOptions.FullyConnectedOptions, fo)
    g.op(S.BuiltinOperator.FULLY_CONNECTED, [xl, wl, -1], [yl], S.BuiltinOptions.FullyConnectedOptions, fo)
    g.op(S.BuiltinOperator.ADD, [yh, yl], [y], S.BuiltinOptions.AddOptions, S.AddOptionsT())
    return p, g.finish(p, [xh, xl], y), dict(s_out=float(s_full))

def build_mul():
    """combine_mul: two IDENTICAL FCs -- same input scale, same weight tensor, same output scale -- so
    nothing distinguishes them for the compiler to copy; the 256 enters AFTER, as a MUL on the hi branch,
    then the ADD. The earlier variants put the 256 on an input or weight scale, which makes the two FCs
    different quantised ops, and the compiler then emitted the weights twice (33.86 MB against 17.04)."""
    W = weights(); s = wscale(); g = Graph(); fo = S.FullyConnectedOptionsT(); fo.keepNumDims = True
    s_dig, s_full = np.float32(0.004), np.float32(0.004 * 256)
    p = os.path.join(OUT, "combine_mul.tflite")
    xh = g.tensor("x_hi", S.TensorType.INT8, [R, N_IN], np.float32(S_ACT))
    xl = g.tensor("x_lo", S.TensorType.INT8, [R, N_IN], np.float32(S_ACT))
    w = g.tensor("w", S.TensorType.INT8, [N_OUT, N_IN], s, W.tobytes())
    yh = g.tensor("y_hi", S.TensorType.INT16, [R, N_OUT], s_dig)
    yl = g.tensor("y_lo", S.TensorType.INT16, [R, N_OUT], s_dig)
    g.op(S.BuiltinOperator.FULLY_CONNECTED, [xh, w, -1], [yh], S.BuiltinOptions.FullyConnectedOptions, fo)
    g.op(S.BuiltinOperator.FULLY_CONNECTED, [xl, w, -1], [yl], S.BuiltinOptions.FullyConnectedOptions, fo)
    k = g.tensor("k256", S.TensorType.INT16, [1], np.float32(1.0), np.array([256], np.int16).tobytes())
    yh256 = g.tensor("y_hi256", S.TensorType.INT16, [R, N_OUT], s_full)
    g.op(S.BuiltinOperator.MUL, [yh, k], [yh256], S.BuiltinOptions.MulOptions, S.MulOptionsT())
    y = g.tensor("y", S.TensorType.INT16, [R, N_OUT], s_full)
    g.op(S.BuiltinOperator.ADD, [yh256, yl], [y], S.BuiltinOptions.AddOptions, S.AddOptionsT())
    return p, g.finish(p, [xh, xl], y), dict(s_out=float(s_full))

if __name__ == "__main__":
    for m in ("split", "combine", "combine_in", "combine_buf", "combine_mul"):
        p, sz, meta = (build(m) if m in ("split", "combine") else build_mul() if m == "combine_mul"
                       else build_shared(m))
        print(f"{m:8} -> {p} ({sz/1e6:.2f} MB uncompiled, s_out {meta['s_out']})")
