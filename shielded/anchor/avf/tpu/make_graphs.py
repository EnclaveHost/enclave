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
ap.add_argument('--digit-combine', action='store_true', help='EXPERIMENTAL, NOT DEPLOYABLE. Recombine the digits '
                'on the TPU: hi and lo as two int8 input tensors, two FULLY_CONNECTEDs whose weight tensors share one '
                'buffer at scales differing by 256, and an elementwise ADD returning one int16 row per logical row. '
                'Bundle magic ETPUB003, which every current payload REFUSES -- deliberately, because nothing has '
                'validated the two-input contract end to end: the app-side worker binds exactly one input '
                '(tpu_worker_jni.cc, in->size() != 1) and the VM still recombines. WHETHER IT EVEN COMPILES IS '
                'UNKNOWN: the AOT compiler is not deterministic here and currently fails on the shipped known-good '
                'layer too, so neither the earlier claim that this works nor the retraction that it does not is '
                'evidence. Any saving (reply 3432 -> 1716 KB/token) and any accuracy change are SIMULATED and '
                'unmeasured on silicon. Implies --digit-split.')
ap.add_argument('--digit-split', action='store_true', help='send each masked row as TWO int8 digits, q = 256*hi + lo, instead of one '
                'int16 row, stacked as rows: hi in [0, rows), lo in [rows, 2*rows). Same bytes OUT and the same weights, but the '
                'compiler no longer stores every weight at two bytes to feed an int16 activation: measured on a real layer, '
                '74.9 -> 36.4 MB compiled, i.e. HALF the bytes the TPU streams per token, which is 338 of the 722 ms a token costs. '
                'Rows are free on this TPU, so one FULLY_CONNECTED still does it. The VM recombines 256*hi + lo, which doubles the '
                'reply; recombining on the TPU instead needs two FCs and MEASURED 71.9 MB - the second FC emits the weights again and '
                'cancels the saving (but see --digit-combine: the "weights emitted twice" measurement behind that claim does NOT hold -- the compiler deduplicates by content). Bundle magic ETPUB002 so a payload that does not digit-split refuses it loudly.')
A = ap.parse_args()
if A.digit_combine:
    A.digit_split = True          # combining is a variant of digit-split, not an alternative to it
os.makedirs(A.outdir, exist_ok=True)
# The digit reply carries both halves at ONE scale, sized for the larger of the two: lo spans +-128 against the
# masked value's +-16384, so its product reaches about 1/128 of a full-range output (hi reaches 1/256). The extra
# 1.25 is headroom against the pad's statistical spread. payload/ggml-tpu.cpp MUST use the same number - it is
# deliberately NOT tied to --margin, so that changing the lane margin cannot silently desynchronise the two.
DIGIT_OUT_DIV = 102.4    # = 128 / 1.25
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

    def _add_op(self, builtin):
        """Register an operator code once and return its index (FULLY_CONNECTED is always index 0)."""
        for i, oc in enumerate(self.m.operatorCodes):
            if oc.builtinCode == builtin:
                return i
        oc = S.OperatorCodeT(); oc.builtinCode = builtin; oc.deprecatedBuiltinCode = builtin; oc.version = 5
        self.m.operatorCodes.append(oc)
        return len(self.m.operatorCodes) - 1
    def _tensor(self, name, ttype, shape, scale, buf=0):
        t = S.TensorT(); t.name = name.encode(); t.type = ttype; t.shape = np.array(shape, np.int32); t.buffer = buf
        q = S.QuantizationParametersT(); q.scale = np.atleast_1d(np.asarray(scale, np.float32)); q.zeroPoint = np.zeros(len(q.scale), np.int64); q.quantizedDimension = 0; t.quantization = q
        return t
    def signature(self, key, rows, g):
        sg = S.SubGraphT(); sg.name = key.encode(); sg.operators = []; outs = []
        if A.digit_split:
            # q = 256*hi + lo, both digits int8, stacked as ROWS of ONE tensor: hi in rows [0, rows), lo in
            # [rows, 2*rows). One FULLY_CONNECTED per projection, exactly as today - which is the whole point.
            #
            # CORRECTION (2026-09-22): this comment used to say that two FCs against a shared weight tensor
            # emit the weights TWICE (35.6 -> 71.9 MB on a real layer), and that is why the recombination was
            # left to the VM. Re-measured, they emit them ONCE: at 1536x6144 one FC compiles to 9.67 MB and
            # two FCs sharing a weight buffer to 9.68 MB, 1.00x. See --digit-combine below, and
            # a8w4/probe_shared_weight.py.
            #
            # Both digit halves share one input scale, so the VM applies the 256 when it recombines.
            if A.digit_combine:
                # hi and lo as SEPARATE inputs. They cannot be one tensor sliced in the graph: SLICE, SPLIT,
                # STRIDED_SLICE, RESHAPE, TRANSPOSE and BATCH_MATMUL all crash the G5 compiler with INTERNAL,
                # whether applied to the FC's output or to its input (a8w4/COMPILER-BUG-slice-after-fc.md).
                sg.tensors = [self._tensor(key + '_xhi', S.TensorType.INT8, [rows, g['n_in']], g['s_in']),
                              self._tensor(key + '_xlo', S.TensorType.INT8, [rows, g['n_in']], g['s_in'])]
                sg.inputs = np.array([0, 1], np.int32)
            else:
                sg.tensors = [self._tensor(key + '_x', S.TensorType.INT8, [2 * rows, g['n_in']], g['s_in'])]
                sg.inputs = np.array([0], np.int32)
        else:
            sg.tensors = [self._tensor(key + '_x', S.TensorType.INT16, [rows, g['n_in']], g['s_in'])]
            sg.inputs = np.array([0], np.int32)
        for p in g['projs']:
            b = S.BufferT(); b.data = np.frombuffer(p['Wq'].tobytes(), np.uint8); self.m.buffers.append(b)
            buf = len(self.m.buffers) - 1
            if A.digit_combine:
                # TWO weight tensors, ONE buffer, scales differing by 256. The 256 has to live in the weights:
                # quantisation scales divide out of the ADD, so two FCs sharing one weight TENSOR would compute
                # W.(hi + lo) rather than W.(256.hi + lo). Both name the same buffer, so the weights stream once.
                whi = len(sg.tensors); sg.tensors.append(self._tensor(key + '_whi' + str(len(outs)), S.TensorType.INT8, p['Wq'].shape, np.asarray(p['sw'], np.float32) * np.float32(256.0), buf))
                wlo = len(sg.tensors); sg.tensors.append(self._tensor(key + '_wlo' + str(len(outs)), S.TensorType.INT8, p['Wq'].shape, p['sw'], buf))
                yhi = len(sg.tensors); sg.tensors.append(self._tensor(key + '_yhi' + str(len(outs)), S.TensorType.INT16, [rows, p['Wq'].shape[0]], p['s_out']))
                ylo = len(sg.tensors); sg.tensors.append(self._tensor(key + '_ylo' + str(len(outs)), S.TensorType.INT16, [rows, p['Wq'].shape[0]], p['s_out']))
                oi = len(sg.tensors); sg.tensors.append(self._tensor(key + '_y' + str(len(outs)), S.TensorType.INT16, [rows, p['Wq'].shape[0]], p['s_out'])); outs.append(oi)
                for xi, wt, yt in ((0, whi, yhi), (1, wlo, ylo)):
                    op = S.OperatorT(); op.opcodeIndex = 0; op.inputs = np.array([xi, wt, -1], np.int32); op.outputs = np.array([yt], np.int32)
                    op.builtinOptionsType = S.BuiltinOptions.FullyConnectedOptions
                    o = S.FullyConnectedOptionsT(); o.keepNumDims = True; op.builtinOptions = o; sg.operators.append(op)
                op = S.OperatorT(); op.opcodeIndex = self._add_op(S.BuiltinOperator.ADD); op.inputs = np.array([yhi, ylo], np.int32); op.outputs = np.array([oi], np.int32)
                op.builtinOptionsType = S.BuiltinOptions.AddOptions; op.builtinOptions = S.AddOptionsT(); sg.operators.append(op)
                continue
            wi = len(sg.tensors); sg.tensors.append(self._tensor(key + '_w' + str(len(outs)), S.TensorType.INT8, p['Wq'].shape, p['sw'], buf))
            # Digit-split doubles the rows, and the reply carries both halves at ONE scale. The bigger of the two
            # is the lo product: lo spans +-128 against the masked value's +-16384, so it reaches about 1/128 of a
            # full-range output, while the hi product reaches 1/256. Scaling the reply for the larger keeps both
            # digits inside int16; the VM then forms 256*y_hi + y_lo, where the hi half's rounding error is
            # amplified by 256 and lands at about one output LSB (sim_digit_split.py: 1.98x the direct path).
            n_rows = 2 * rows if A.digit_split else rows
            s_y = np.float32(float(p['s_out']) / DIGIT_OUT_DIV) if A.digit_split else p['s_out']
            oi = len(sg.tensors); sg.tensors.append(self._tensor(key + '_y' + str(len(outs)), S.TensorType.INT16, [n_rows, p['Wq'].shape[0]], s_y)); outs.append(oi)
            op = S.OperatorT(); op.opcodeIndex = 0; op.inputs = np.array([0, wi, -1], np.int32); op.outputs = np.array([oi], np.int32)
            op.builtinOptionsType = S.BuiltinOptions.FullyConnectedOptions; o = S.FullyConnectedOptionsT(); o.keepNumDims = True; op.builtinOptions = o; sg.operators.append(op)
        sg.outputs = np.array(outs, np.int32); self.m.subgraphs.append(sg)
        sd = S.SignatureDefT(); sd.signatureKey = key.encode(); sd.subgraphIndex = len(self.m.subgraphs) - 1
        if A.digit_combine:
            # ORDER matters: the worker writes the first half of the wire into input 0 and the second into 1,
            # and the wire carries hi then lo.
            t0 = S.TensorMapT(); t0.name = b'x'; t0.tensorIndex = 0
            t1 = S.TensorMapT(); t1.name = b'x1'; t1.tensorIndex = 1
            sd.inputs = [t0, t1]
        else:
            tm = S.TensorMapT(); tm.name = b'x'; tm.tensorIndex = 0; sd.inputs = [tm]
        sd.outputs = []
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
    # The marker is the ONLY thing standing between a payload and a bundle whose graphs expect a different
    # wire contract, and a mismatch decodes to plausible nonsense rather than failing (the modular-lane
    # lesson). So each contract gets its own:
    #   ETPUB001  one int16 row per logical row, ONE graph input
    #   ETPUB002  two int8 digit rows stacked, ONE graph input, the VM recombines
    #   ETPUB003  two int8 digit rows as TWO graph inputs, the accelerator recombines, reply is one row
    # A combine bundle previously wrote ETPUB002, which an ETPUB002 payload ACCEPTS while its graphs take
    # a different number of inputs entirely. That is exactly the silent mismatch this field exists to stop.
    magic = b'ETPUB003' if A.digit_combine else (b'ETPUB002' if A.digit_split else b'ETPUB001')
    f.write(magic + struct.pack('<I', len(groups))); pad8(f)
    for g in groups:
        f.write(struct.pack('<HBBIff', g['layer'], g['kind'], len(g['projs']), g['n_in'], float(g['s_in']), -1.0 if A.modular else A.k))
        f.write(g['s'].tobytes()); f.write(g['sig_q'].tobytes()); f.write(g['r_amp'].tobytes()); pad8(f)
        for p in g['projs']:
            f.write(p['name'].encode().ljust(64, b'\0')); f.write(struct.pack('<Ifi', p['Wq'].shape[0], float(p['s_out']), p['budget']))
            f.write(p['sw'].tobytes()); f.write(p['Wq'].tobytes()); pad8(f)
print(f'bundle: {A.outdir}/lanes.etpu {os.path.getsize(A.outdir + "/lanes.etpu") >> 20} MB, {len(groups)} groups, rows={A.rows}, '
      f'{"MODULAR (per-channel power-of-two moduli, k field = -1)" if A.modular else f"k={A.k}"}, alpha={A.alpha}')
