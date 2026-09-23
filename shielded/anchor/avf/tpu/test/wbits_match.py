#!/usr/bin/env python3
"""wbits_match.py <build_dir> -- the TPU multiplies by EXACTLY the integers the VM cancels with.

The masking is only exact because the VM computes each pad's correction with the same integer matrix the
TPU applies: the VM's round(M_j * sum_i Wq[j,i] r_i) and the TPU's round(M_j * sum_i Wq[j,i] (x+r)_i) must
use one Wq. The bundle (lanes.etpu, read by the VM) and the graphs (L<n>.tflite, run by the TPU) are
written from the same array, but by two different paths -- and for int4 the graph path PACKS the values two
to a byte while the bundle keeps them as int8. A packing slip there would not crash anything: the TPU would
multiply by different weights than the VM cancels with, and the unmasked output would be quietly wrong.

So this reads BOTH files independently, unpacks every graph weight tensor, and compares every integer and
every per-row scale against the bundle. Exit 0 only if all of them match.
"""
import os, struct, sys
import numpy as np
from ai_edge_litert.tools import flatbuffer_utils as fu
from ai_edge_litert import schema_py_generated as S

KINDS = {0: 'qkv', 1: 'o', 2: 'gu', 3: 'down'}

def read_bundle(path):
    b = open(path, 'rb').read(); o = 0
    def take(n):
        nonlocal o; v = b[o:o + n]; o += n; return v
    def pad8():
        nonlocal o; o = (o + 7) & ~7
    magic = take(8).decode(); ng, = struct.unpack('<I', take(4)); pad8()
    groups = []
    for _ in range(ng):
        layer, kind, nproj, n_in, s_in, k = struct.unpack('<HBBIff', take(16))
        take(4 * n_in); take(2 * n_in); take(2 * n_in); pad8()
        projs = []
        for _ in range(nproj):
            name = take(64).rstrip(b'\0').decode(); n_out, s_out, budget = struct.unpack('<Ifi', take(12))
            sw = np.frombuffer(take(4 * n_out), np.float32)
            Wq = np.frombuffer(take(n_out * n_in), np.int8).reshape(n_out, n_in); pad8()
            projs.append((name, sw, Wq))
        groups.append((layer, kind, projs))
    return magic, groups

def graph_weight(m, sg, name):
    for t in sg.tensors:
        if (t.name.decode() if isinstance(t.name, bytes) else t.name) == name:
            raw = np.asarray(m.buffers[t.buffer].data, np.uint8)
            shape = tuple(int(v) for v in t.shape); n = int(np.prod(shape))
            if t.type == S.TensorType.INT4:
                lo = (raw & 0x0F).astype(np.int8); hi = ((raw >> 4) & 0x0F).astype(np.int8)
                v = np.empty(raw.size * 2, np.int8); v[0::2] = lo; v[1::2] = hi
                v = np.where(v > 7, v - 16, v).astype(np.int8)[:n]        # sign-extend the nibble
                kind = 'INT4'
            elif t.type == S.TensorType.INT8:
                v = raw.view(np.int8)[:n]; kind = 'INT8'
            else:
                return None, None, f"unexpected tensor type {t.type}"
            return v.reshape(shape), np.asarray(t.quantization.scale, np.float32), kind
    return None, None, "missing"

def main():
    d = sys.argv[1]
    magic, groups = read_bundle(os.path.join(d, 'lanes.etpu'))
    models = {}; checked = mism = sc_mism = weights = 0; kinds = set()
    for layer, kind, projs in groups:
        if layer not in models:
            models[layer] = fu.read_model(os.path.join(d, f'L{layer}.tflite'))
        m = models[layer]
        sg = next((g for g in m.subgraphs if (g.name.decode() if isinstance(g.name, bytes) else g.name) == KINDS[kind]), None)
        if sg is None:
            print(f"FAIL L{layer} {KINDS[kind]}: signature missing from the graph"); return 1
        for i, (name, sw, Wq) in enumerate(projs):
            gv, gs, gk = graph_weight(m, sg, f'{KINDS[kind]}_w{i}')
            if gv is None:
                print(f"FAIL L{layer} {KINDS[kind]}_w{i} ({name}): {gk}"); return 1
            kinds.add(gk); checked += 1; weights += Wq.size
            if gv.shape != Wq.shape or not np.array_equal(gv, Wq):
                mism += 1; print(f"MISMATCH L{layer} {KINDS[kind]}_w{i} ({name}): {int((gv != Wq).sum()) if gv.shape == Wq.shape else 'shape'} integers differ")
            if gs.shape != sw.shape or not np.array_equal(gs, sw):
                sc_mism += 1; print(f"MISMATCH L{layer} {KINDS[kind]}_w{i} ({name}): per-row scales differ")
    rng = (min(int(g[2][0][2].min()) for g in groups), max(int(g[2][0][2].max()) for g in groups))
    print(f"{magic}: {checked} projections in {len(groups)} groups, {weights:,} weights, graph tensors {sorted(kinds)}, "
          f"bundle integer range {rng}")
    print(f"  integer mismatches: {mism}   scale mismatches: {sc_mism}")
    return 0 if (mism == 0 and sc_mism == 0 and checked > 0) else 1

if __name__ == '__main__':
    sys.exit(main())
