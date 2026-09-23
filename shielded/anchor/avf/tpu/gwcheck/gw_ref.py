#!/usr/bin/env python3
"""gw_ref.py <authored.tflite> <sig_index> <prefix> -- is what the TPU returned the integer product the VM cancels with?

gwcheck (GWCHECK_SIG=<i>) ran one signature of a compiled layer on the NPU with deterministic int8 rows and
dumped <prefix>.in0 and <prefix>.out<k>. This recomputes every output from the AUTHORED graph -- its weights
(INT8, or INT4 unpacked low nibble first, the way make_graphs.py packs and wbits_match.py reads), its per-channel
weight scales and its input/output scales -- as

    y = sat16(round(acc * s_x * sw_j / s_y)),     acc = sum_i W[j,i] x_i  (exact, int64)

which is the expression the VM's pad correction assumes. A deviation of 1 LSB is the requantiser's rounding
(TPU.md's established tolerance); anything larger means the TPU computed a different product.

When the int4 comparison fails, it also scores two alternative readings of the same bytes -- nibbles swapped,
and nibbles read unsigned -- so a packing-convention mismatch is named rather than guessed at.
"""
import sys
import numpy as np
from ai_edge_litert.tools import flatbuffer_utils as fu
from ai_edge_litert import schema_py_generated as S


def unpack4(raw, n, mode):
    lo = (raw & 0x0F).astype(np.int16); hi = ((raw >> 4) & 0x0F).astype(np.int16)
    v = np.empty(raw.size * 2, np.int16)
    if mode == 'swapped': v[0::2], v[1::2] = hi, lo
    else: v[0::2], v[1::2] = lo, hi
    if mode != 'unsigned': v = np.where(v > 7, v - 16, v)
    return v[:n]


def main():
    path, sig, pre = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    m = fu.read_model(path); sg = m.subgraphs[sig]
    x = None; worst = 0; fails = 0; report = []
    for k, o in enumerate(sg.operators):
        ti, tw = sg.tensors[o.inputs[0]], sg.tensors[o.inputs[1]]; ty = sg.tensors[o.outputs[0]]
        if x is None:
            x = np.fromfile(pre + '.in0', np.int8).astype(np.int64).reshape([int(v) for v in ti.shape])
        n_out, n_in = [int(v) for v in tw.shape]
        raw = np.asarray(m.buffers[tw.buffer].data, np.uint8)
        s_x = float(ti.quantization.scale[0]); sw = np.asarray(tw.quantization.scale, np.float64); s_y = float(ty.quantization.scale[0])
        name = pre + ('.out' if len(sg.operators) == 1 else f'.out{k}')
        got = np.fromfile(name, np.int16).astype(np.int64).reshape(x.shape[0], n_out)
        modes = ['signed'] if tw.type == S.TensorType.INT8 else ['signed', 'swapped', 'unsigned']
        for mode in modes:
            W = (raw.view(np.int8).astype(np.int64) if tw.type == S.TensorType.INT8 else unpack4(raw, n_out * n_in, mode).astype(np.int64)).reshape(n_out, n_in)
            acc = x @ W.T
            ref = np.clip(np.round(acc * (s_x * sw[None, :] / s_y)), -32768, 32767)
            d = np.abs(ref - got); mx = int(d.max()); over = int((d > 1).sum())
            report.append(f"  {tw.name.decode():10s} [{n_out}x{n_in}] {'INT8' if tw.type == S.TensorType.INT8 else 'INT4'} read {mode:8s}: "
                          f"max |ref - tpu| {mx} LSB, {over} of {d.size} beyond 1 LSB, rails in tpu {int((np.abs(got) >= 32767).sum())}")
            if mode == 'signed':
                worst = max(worst, mx); fails += over
                if over == 0: break          # the intended reading matches; the alternatives would only add noise
    print(f"{path} sig {sig}:"); print("\n".join(report))
    print(f"{'PASS' if fails == 0 else 'FAIL'}: worst {worst} LSB, {fails} outputs beyond the 1-LSB tolerance")
    return 0 if fails == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
