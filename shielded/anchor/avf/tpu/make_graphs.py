#!/usr/bin/env python3
"""make_graphs.py <model-f16.gguf> <lanes.npz> <outdir> [--k 8] [--alpha 0.5] [--margin 1.25] [--sigmas 5] [--rows 5] [--layers 0-34]

Shielded-TPU artifacts from PUBLIC data (TPU.md): for every transformer block one quantized TFLite file
(L<n>.tflite, signatures qkv | o | gu | down, int16 rows in -> int16 rows out, one int16x8 FULLY_CONNECTED per
projection with per-output-channel int8 weights, no bias) and ONE lane bundle (lanes.etpu) that the protected VM
reads. The flatbuffers are authored here directly, so the int8 weights the TPU multiplies by ARE the bundle's bytes:
the VM's pad  round(M_j * sum_i Wq[j,i] r_i)  and the TPU's  round(M_j * sum_i Wq[j,i] (x+r)_i)  use one matrix.

Lane recipe (measured: KL 0.005 vs fp32 at k=8, against 0.003 for unblinded w8a16 and 0.13-0.54 without the split):
  s_i      = cmax_i^alpha / mean(...)                 smoothing, folded into the weights: W' = W diag(s), x' = x / s
  lane_i   = margin * q999(|x_i|) / s_i               the signal lane; an entry beyond it NEVER leaves the VM (sparse, exact)
  s_in     = max_i lane_i * (1 + k) / 32767           one int16 input scale per exchange group (q,k,v share x; gate,up share x)
  r_amp_i  = floor(k * lane_i / s_in)                 the pad's amplitude per channel: k times the channel's own signal lane
  s_out    = (margin * max|W x| + sigmas * sigma(W r)) / 32767 ; a pad whose W r exceeds its share is re-drawn at minting

Bundle (little endian): "ETPUB001", u32 groups, then per group
  u16 layer, u8 kind (0 qkv, 1 o, 2 gu, 3 down), u8 nproj, u32 n_in, f32 s_in, f32 k, f32 s[n_in], i16 sig_q[n_in], i16 r_amp[n_in], pad to 8,
  per projection: char name[64], u32 n_out, f32 s_out, i32 pad_budget_q, f32 sw[n_out], i8 Wq[n_out * n_in] (row major), pad to 8."""
import argparse, os, struct, sys
import numpy as np
from gguf import GGUFReader
from ai_edge_litert.tools import flatbuffer_utils as fu
from ai_edge_litert import schema_py_generated as S

ap = argparse.ArgumentParser(); ap.add_argument('gguf'); ap.add_argument('lanes'); ap.add_argument('outdir')
ap.add_argument('--k', type=float, default=8.0); ap.add_argument('--alpha', type=float, default=0.5); ap.add_argument('--margin', type=float, default=1.25)
ap.add_argument('--sigmas', type=float, default=5.0); ap.add_argument('--rows', type=int, default=5); ap.add_argument('--layers', default='')
ap.add_argument('--modular', action='store_true', help='per-channel MODULAR pads instead of the bounded statistical ones (see below)')
ap.add_argument('--no-graphs', action='store_true', help='write only the lane bundle (for the workstation reference worker)')
ap.add_argument('--mod-headroom', type=float, default=1.0, help='modular: modulus = next power of two above headroom*(2*sig_q+1). '
                'Security is IDENTICAL for every value (the pad is uniform on the modulus either way); this only trades '
                'resolution against the VM-side wrap correction, whose density falls as 1/headroom.')
A = ap.parse_args(); os.makedirs(A.outdir, exist_ok=True)
SIG_MAX = 16383          # modular: the modulus is the next power of two above 2*sig_q+1 and must stay <= 32768, so that
                         # |r| <= 16384 and the batched minter's r = 256*hi + lo keeps |hi| <= 127 (payload/ggml-tpu.cpp)
LANES = np.load(A.lanes); R = GGUFReader(A.gguf); T = {t.name: t for t in R.tensors}
n_layer = 1 + max(int(n.split('.')[1]) for n in T if n.startswith('blk.'))
want = range(n_layer)
if A.layers: lo, _, hi = A.layers.partition('-'); want = range(int(lo), int(hi or lo) + 1)
KINDS = [(0, 'qkv', ['attn_q', 'attn_k', 'attn_v']), (1, 'o', ['attn_output']), (2, 'gu', ['ffn_gate', 'ffn_up']), (3, 'down', ['ffn_down'])]

def weight(name):
    t = T[name]; w = np.asarray(t.data)
    if w.dtype not in (np.float16, np.float32): sys.exit(f'{name}: expected an f16/f32 GGUF, found tensor type {t.tensor_type.name}')
    n_in, n_out = int(t.shape[0]), int(t.shape[1])                         # ggml: ne0 = columns (input), ne1 = rows (output)
    return w.astype(np.float64).reshape(n_out, n_in)

def group(layer, names):
    lead = f'blk.{layer}.{names[0]}.weight'
    c = np.maximum(LANES[lead + '|max'].astype(np.float64), 1e-3); q = np.maximum(LANES[lead + '|q'].astype(np.float64), 1e-3)
    s = c ** A.alpha; s = s / s.mean() if A.alpha > 0 else np.ones_like(c)
    lane = q / s * A.margin
    if A.modular:
        # A modular pad needs NO headroom: q = (x + r) mod m with r uniform on Z_m is a perfect one-time pad for any
        # m >= the signal's own range, so the signal keeps the whole domain and the pad is the size of the SIGNAL
        # rather than k times it. r_amp carries log2(m) per channel; k = -1 marks the bundle modular.
        s_in = lane.max() / max(np.floor(SIG_MAX / A.mod_headroom), 1.0)
        sig_q = np.clip(np.floor(lane / s_in), 1, SIG_MAX).astype(np.int16)
        mod = np.minimum(2.0 ** np.ceil(np.log2(A.mod_headroom * (2 * sig_q.astype(np.float64) + 1))), 32768.0)
        r_amp = np.round(np.log2(mod)).astype(np.int16)                     # the bundle stores log2(m), not an amplitude
        pad_span = mod                                                      # r is uniform on the WHOLE modulus
    else:
        s_in = lane.max() * (1 + A.k) / 32767.0
        sig_q = np.maximum(np.floor(lane / s_in), 1).astype(np.int16); r_amp = np.floor(A.k * lane / s_in).astype(np.int16)
        pad_span = 2 * r_amp.astype(np.float64) + 1
    projs = []
    for nm in names:
        full = f'blk.{layer}.{nm}.weight'
        if full not in T or (full + '|out') not in LANES.files: continue    # KV-shared layers never run attn_k / attn_v (the GGUF may still carry them): no calibration, no graph
        Wp = weight(full) * s[None, :]; sw = np.maximum(np.abs(Wp).max(1), 1e-12) / 127.0
        Wq = np.clip(np.round(Wp / sw[:, None]), -127, 127).astype(np.int8)
        sig = np.sqrt((((s_in * pad_span / 12 ** .5)[None, :] * Wq * sw[:, None]) ** 2).sum(1)).max()
        signal = float(LANES[full + '|out']) * A.margin; s_out = (signal + A.sigmas * sig) / 32767.0
        projs.append(dict(name=full, Wq=Wq, sw=sw.astype(np.float32), s_out=np.float32(s_out), budget=int(np.floor(A.sigmas * sig / s_out))))
    return dict(layer=layer, n_in=len(c), s_in=np.float32(s_in), s=s.astype(np.float32), sig_q=sig_q, r_amp=r_amp, projs=projs)

class Builder:
    def __init__(self):
        self.m = S.ModelT(); self.m.version = 3; self.m.description = b'enclave shielded int16 lanes'; self.m.operatorCodes = []; self.m.subgraphs = []
        self.m.buffers = [S.BufferT()]; self.m.signatureDefs = []; self.m.metadata = []
        oc = S.OperatorCodeT(); oc.builtinCode = S.BuiltinOperator.FULLY_CONNECTED; oc.deprecatedBuiltinCode = S.BuiltinOperator.FULLY_CONNECTED; oc.version = 5; self.m.operatorCodes.append(oc)
    def _tensor(self, name, ttype, shape, scale, buf=0):
        t = S.TensorT(); t.name = name.encode(); t.type = ttype; t.shape = np.array(shape, np.int32); t.buffer = buf
        q = S.QuantizationParametersT(); q.scale = np.atleast_1d(np.asarray(scale, np.float32)); q.zeroPoint = np.zeros(len(q.scale), np.int64); q.quantizedDimension = 0; t.quantization = q
        return t
    def signature(self, key, rows, g):
        sg = S.SubGraphT(); sg.name = key.encode(); sg.tensors = [self._tensor(key + '_x', S.TensorType.INT16, [rows, g['n_in']], g['s_in'])]; sg.operators = []; sg.inputs = np.array([0], np.int32); outs = []
        for p in g['projs']:
            b = S.BufferT(); b.data = np.frombuffer(p['Wq'].tobytes(), np.uint8); self.m.buffers.append(b)
            wi = len(sg.tensors); sg.tensors.append(self._tensor(key + '_w' + str(len(outs)), S.TensorType.INT8, p['Wq'].shape, p['sw'], len(self.m.buffers) - 1))
            oi = len(sg.tensors); sg.tensors.append(self._tensor(key + '_y' + str(len(outs)), S.TensorType.INT16, [rows, p['Wq'].shape[0]], p['s_out'])); outs.append(oi)
            op = S.OperatorT(); op.opcodeIndex = 0; op.inputs = np.array([0, wi, -1], np.int32); op.outputs = np.array([oi], np.int32)
            op.builtinOptionsType = S.BuiltinOptions.FullyConnectedOptions; o = S.FullyConnectedOptionsT(); o.keepNumDims = True; op.builtinOptions = o; sg.operators.append(op)
        sg.outputs = np.array(outs, np.int32); self.m.subgraphs.append(sg)
        sd = S.SignatureDefT(); sd.signatureKey = key.encode(); sd.subgraphIndex = len(self.m.subgraphs) - 1
        tm = S.TensorMapT(); tm.name = b'x'; tm.tensorIndex = 0; sd.inputs = [tm]; sd.outputs = []
        for n, i in enumerate(outs): tm = S.TensorMapT(); tm.name = f'y{n}'.encode(); tm.tensorIndex = i; sd.outputs.append(tm)
        self.m.signatureDefs.append(sd)

def pad8(f): f.write(b'\0' * (-f.tell() % 8))
groups = []
for L in want:
    b = Builder()
    for kind, key, names in KINDS:
        g = group(L, names); g['kind'] = kind; groups.append(g); b.signature(key, A.rows, g)
    if not A.no_graphs: fu.write_model(b.m, f'{A.outdir}/L{L}.tflite')
    print(f'L{L}: {(os.path.getsize(f"{A.outdir}/L{L}.tflite") >> 20) if not A.no_graphs else 0} MB, ' + ', '.join(f"{KINDS[g['kind']][1]}[{'+'.join(p['name'].split('.')[2] for p in g['projs'])}] s_in={g['s_in']:.3g}" for g in groups[-4:]), flush=True)
with open(f'{A.outdir}/lanes.etpu', 'wb') as f:
    f.write(b'ETPUB001' + struct.pack('<I', len(groups))); pad8(f)
    for g in groups:
        f.write(struct.pack('<HBBIff', g['layer'], g['kind'], len(g['projs']), g['n_in'], float(g['s_in']), -1.0 if A.modular else A.k))
        f.write(g['s'].tobytes()); f.write(g['sig_q'].tobytes()); f.write(g['r_amp'].tobytes()); pad8(f)
        for p in g['projs']:
            f.write(p['name'].encode().ljust(64, b'\0')); f.write(struct.pack('<Ifi', p['Wq'].shape[0], float(p['s_out']), p['budget']))
            f.write(p['sw'].tobytes()); f.write(p['Wq'].tobytes()); pad8(f)
print(f'bundle: {A.outdir}/lanes.etpu {os.path.getsize(A.outdir + "/lanes.etpu") >> 20} MB, {len(groups)} groups, rows={A.rows}, '
      f'{"MODULAR (per-channel power-of-two moduli, k field = -1)" if A.modular else f"k={A.k}"}, alpha={A.alpha}')
