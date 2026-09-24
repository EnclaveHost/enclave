#!/usr/bin/env python3
"""NOT WIRED IN (TPU.md): the chained row can only be masked with a bounded pad, which leaks (E1). Kept as the record.
make_graphs2.py <model-f16.gguf> <lanes.npz> <outdir> [--k 8] [--alpha 0.5] [--margin 1.25] [--sigmas 5] [--heavy 64] [--layers 0-34]

The CHAINED Shielded-TPU artifacts (TPU.md, "Can a mask survive the nonlinear steps?"): two calls per block instead of four,
because an RMSNorm is a positive scalar times a public diagonal and the VM applies the scalar afterwards.

  call `ogu` (block L):   a -> W_o -> o_q [returned]  ; z = o_q + C0 ; rb = z * mR + C1 ; rows [xsA ; rb] -> W_gate, W_up
  call `dq`  (block L):   y -> W_down -> d_q [returned]; z = d_q + C0 ; rb = z * mR + C1 ; rows [xsA ; rb] -> W_q, W_k, W_v of block L+1
  C0 = -P_prev + r'  (the VM re-masks the intermediate with a fresh pad shaped to its own signal), C1 = the VM-side outlier share
  of the previous multiply at the chained row's resolution, xsA = the VM-known row (g_f*x/rms(x), or g_a*h0/rms(h0)) masked as usual.
  mR are INTEGER per-channel multipliers (the residual factor lives in the shared weights' column scale), 0 for the `heavy`
  channels, which the VM multiplies itself from the returned o_q / d_q (column slices in the bundle). Block 0 keeps a plain `qkv`
  call and the last block a plain `down` call.

Bundle "ETPUB002": the "ETPUB001" groups for kinds 0 (block 0 only), 1 and 3 (all blocks), then per chained call a group record of
kind 4 (ogu) or 5 (dq) for the SECOND stage (row A's lanes, s_out = s_in * c0) followed by the chain tail:
  u8 prev_kind, u8 n_prev_proj(=1), u16 n_heavy, f32 s_inR, f32 c0, f32 osc, i16 mR[n_in], i16 ampR[n_in], f32 gains1[n_in], f32 gains2[n_in],
  u16 heavy[n_heavy], pad to 8, then per projection: i32 budgetB, i8 Wcol[n_out * n_heavy] (column-major slices), pad to 8.
Every number here is public: weights, calibration statistics, norm gains."""
import argparse, os, struct, sys
import numpy as np
from gguf import GGUFReader
from ai_edge_litert.tools import flatbuffer_utils as fu
from ai_edge_litert import schema_py_generated as S

ap = argparse.ArgumentParser(); ap.add_argument('gguf'); ap.add_argument('lanes'); ap.add_argument('outdir')
ap.add_argument('--k', type=float, default=8.0); ap.add_argument('--alpha', type=float, default=0.5); ap.add_argument('--margin', type=float, default=1.25)
ap.add_argument('--sigmas', type=float, default=5.0); ap.add_argument('--heavy', type=int, default=64); ap.add_argument('--layers', default='')
A = ap.parse_args(); os.makedirs(A.outdir, exist_ok=True)
LANES = np.load(A.lanes); R = GGUFReader(A.gguf); T = {t.name: t for t in R.tensors}
n_layer = 1 + max(int(n.split('.')[1]) for n in T if n.startswith('blk.'))
want = range(n_layer)
if A.layers: lo, _, hi = A.layers.partition('-'); want = range(int(lo), int(hi or lo) + 1)
rng = np.random.default_rng(2026)
A16, I8 = S.TensorType.INT16, S.TensorType.INT8

def weight(name):
    t = T[name]; w = np.asarray(t.data)
    if w.dtype not in (np.float16, np.float32): sys.exit(f'{name}: expected an f16/f32 GGUF, found tensor type {t.tensor_type.name}')
    return w.astype(np.float64).reshape(int(t.shape[1]), int(t.shape[0]))
def vec(name): return np.asarray(T[name].data).astype(np.float64).reshape(-1)

def plain_group(layer, kind, names):
    """The ETPUB001 recipe for a VM-known row (make_graphs.py)."""
    lead = f'blk.{layer}.{names[0]}.weight'
    c = np.maximum(LANES[lead + '|max'].astype(np.float64), 1e-3); q = np.maximum(LANES[lead + '|q'].astype(np.float64), 1e-3)
    s = c ** A.alpha; s = s / s.mean() if A.alpha > 0 else np.ones_like(c)
    lane = q / s * A.margin; s_in = lane.max() * (1 + A.k) / 32767.0
    sig_q = np.maximum(np.floor(lane / s_in), 1).astype(np.int16); r_amp = np.floor(A.k * lane / s_in).astype(np.int16)
    projs = []
    for nm in names:
        full = f'blk.{layer}.{nm}.weight'
        if full not in T or (full + '|out') not in LANES.files: continue
        Wp = weight(full) * s[None, :]; sw = np.maximum(np.abs(Wp).max(1), 1e-12) / 127.0
        Wq = np.clip(np.round(Wp / sw[:, None]), -127, 127).astype(np.int8)
        sig = np.sqrt((((s_in * r_amp.astype(np.float64) / 3 ** .5)[None, :] * Wq * sw[:, None]) ** 2).sum(1))
        signal = float(LANES[full + '|out']) * A.margin; s_out = (signal + A.sigmas * sig.max()) / 32767.0
        projs.append(dict(name=full, Wq=Wq, sw=sw.astype(np.float32), s_out=np.float32(s_out), budget=int(np.floor(A.sigmas * sig.max() / s_out)), sig_rows=sig))
    return dict(layer=layer, kind=kind, n_in=len(c), s_in=np.float32(s_in), s=s.astype(np.float32), sig_q=sig_q, r_amp=r_amp, projs=projs, chain=None)

def chain_group(layer, kind, prev, names, gains1, gains2, osc, Lk):
    """The second stage of a chained call: row A from the chain calibration, row B re-masked (sim_chain.py, REMASK + INTMUL + heavy)."""
    key = f'chain.{Lk}.{"gu" if kind == 4 else "qkv"}'
    cA = np.maximum(LANES[key + '.A_max'].astype(np.float64), 1e-3); qA = np.maximum(LANES[key + '.A_q'].astype(np.float64), 1e-3); Bmax = LANES[key + '.B_max'].astype(np.float64)
    s = cA ** A.alpha; s = s / s.mean() if A.alpha > 0 else np.ones_like(cA)
    gains = gains1 * gains2; prev_out = prev['projs'][0]; n = len(cA)
    heavy = np.zeros(n, bool); heavy[np.argsort(-(Bmax / s))[:A.heavy]] = True
    keep = ~heavy; v = np.where(keep, gains / s, 0.0)
    laneB = np.maximum(Bmax / s * A.margin, 1e-9) * keep; s_inR = laneB.max() * (1 + A.k) / 32767.0
    mR0 = float(prev_out['s_out']) * v / s_inR
    small = keep & (np.abs(mR0) < 0.5); heavy |= small; keep = ~heavy; v = np.where(keep, gains / s, 0.0); mR0 = np.where(keep, mR0, 0.0)  # a channel whose grid is finer than the row's counts as heavy: every multiplier is an integer
    cI = np.where(keep, np.round(np.abs(mR0)) * np.sign(mR0), 0.0); cI = np.where(keep & (cI == 0), np.sign(mR0), cI)
    fac = np.where(keep, mR0 / np.where(cI == 0, 1.0, cI), 1.0); s = s * fac; v = np.where(keep, gains / s, 0.0)
    lane = qA / s * A.margin; s_in = lane.max() * (1 + A.k) / 32767.0
    sig_q = np.maximum(np.floor(lane / s_in), 1).astype(np.int16); r_amp = np.floor(A.k * lane / s_in).astype(np.int16)
    laneB = np.maximum(Bmax / s * A.margin, 1e-9) * keep
    mR = np.round(np.where(keep, float(prev_out['s_out']) * v / s_inR, 0.0)); assert np.all(np.abs(mR - cI) < 1e-6), 'integer multipliers'
    ampR = np.clip(np.floor(A.k * laneB / s_inR / np.maximum(np.abs(mR), 1e-12)), 0, 30000) * keep
    projs = []; rA_max = rB_max = 0.0
    for nm in names:
        full = f'blk.{Lk}.{nm}.weight'
        if full not in T or (key + f'.{nm}.outA') not in LANES.files: continue
        Wp = weight(full) * s[None, :]; sw = np.maximum(np.abs(Wp).max(1), 1e-12) / 127.0
        Wq = np.clip(np.round(Wp / sw[:, None]), -127, 127).astype(np.int8)
        sigA = np.sqrt((((s_in * r_amp.astype(np.float64) / 3 ** .5)[None, :] * Wq * sw[:, None]) ** 2).sum(1)).max()
        sigR = np.sqrt((((s_inR * (ampR * np.abs(mR)) / 3 ** .5)[None, :] * Wq * sw[:, None]) ** 2).sum(1)).max()
        rA = float(LANES[key + f'.{nm}.outA']) * A.margin + A.sigmas * sigA; rB = float(LANES[key + f'.{nm}.outB']) * A.margin + A.sigmas * sigR
        c0 = max(rA / s_in, rB / s_inR) / 32767.0
        projs.append(dict(name=full, Wq=Wq, sw=sw.astype(np.float32), c0=c0, budgetA=int(np.floor(A.sigmas * sigA / (s_in * c0))), budgetB=int(np.floor(A.sigmas * sigR / (s_inR * c0))),
                          Wcol=np.ascontiguousarray(Wq[:, heavy].T)))   # [n_heavy][n_out]: one contiguous row per heavy channel for the VM's share
    c0 = max(p['c0'] for p in projs)                                     # one output scale per call (the rows are concatenated)
    for p in projs: p['s_out'] = np.float32(s_in * c0); p['budget'] = int(np.floor(p['budgetA'] * p['c0'] / c0)); p['budgetB'] = int(np.floor(p['budgetB'] * p['c0'] / c0))
    return dict(layer=layer, kind=kind, n_in=n, s_in=np.float32(s_in), s=s.astype(np.float32), sig_q=sig_q, r_amp=r_amp, projs=projs,
                chain=dict(prev=prev, s_inR=np.float32(s_inR), c0=np.float32(c0), osc=np.float32(osc), mR=mR.astype(np.int16), ampR=ampR.astype(np.int16),
                           gains1=gains1.astype(np.float32), gains2=gains2.astype(np.float32), heavy=np.flatnonzero(heavy).astype(np.uint16)))

class Builder:
    def __init__(self):
        self.m = S.ModelT(); self.m.version = 3; self.m.description = b'Enclave Shield int16 lanes, chained'; self.m.operatorCodes = []; self.m.subgraphs = []
        self.m.buffers = [S.BufferT()]; self.m.signatureDefs = []; self.m.metadata = []; self.codes = {}
    def code(self, op, ver):
        if op not in self.codes:
            oc = S.OperatorCodeT(); oc.builtinCode = op; oc.deprecatedBuiltinCode = min(op, 127); oc.version = ver; self.m.operatorCodes.append(oc); self.codes[op] = len(self.m.operatorCodes) - 1
        return self.codes[op]
    def tensor(self, sg, name, ttype, shape, scale, data=None):
        t = S.TensorT(); t.name = name.encode(); t.type = ttype; t.shape = np.array(shape, np.int32); t.buffer = 0
        if data is not None: b = S.BufferT(); b.data = np.frombuffer(data, np.uint8); self.m.buffers.append(b); t.buffer = len(self.m.buffers) - 1
        q = S.QuantizationParametersT(); q.scale = np.atleast_1d(np.asarray(scale, np.float32)); q.zeroPoint = np.zeros(len(q.scale), np.int64); q.quantizedDimension = 0; t.quantization = q
        sg.tensors.append(t); return len(sg.tensors) - 1
    def op(self, sg, kind, ins, outs, ver=1, opts=None, ot=None):
        o = S.OperatorT(); o.opcodeIndex = self.code(kind, ver); o.inputs = np.array(ins, np.int32); o.outputs = np.array(outs, np.int32)
        if opts is not None: o.builtinOptionsType = ot; o.builtinOptions = opts
        sg.operators.append(o)
    def fc(self, sg, x, p, rows, name, s_out):
        wi = self.tensor(sg, name + '_w', I8, p['Wq'].shape, p['sw'], p['Wq'].tobytes()); yi = self.tensor(sg, name + '_y', A16, [rows, p['Wq'].shape[0]], s_out)
        fo = S.FullyConnectedOptionsT(); fo.keepNumDims = True; self.op(sg, S.BuiltinOperator.FULLY_CONNECTED, [x, wi, -1], [yi], 5, fo, S.BuiltinOptions.FullyConnectedOptions); return yi
    def signature(self, key, ins, outs, sg):
        sg.inputs = np.array([i for _, i in ins], np.int32); sg.outputs = np.array([i for _, i in outs], np.int32); self.m.subgraphs.append(sg)
        sd = S.SignatureDefT(); sd.signatureKey = key.encode(); sd.subgraphIndex = len(self.m.subgraphs) - 1; sd.inputs = []; sd.outputs = []
        for lst, src in ((sd.inputs, ins), (sd.outputs, outs)):
            for n, i in src: tm = S.TensorMapT(); tm.name = n.encode(); tm.tensorIndex = i; lst.append(tm)
        self.m.signatureDefs.append(sd)
    def plain(self, key, g):
        sg = S.SubGraphT(); sg.name = key.encode(); sg.tensors = []; sg.operators = []; x = self.tensor(sg, 'x', A16, [1, g['n_in']], g['s_in']); outs = []
        for n, p in enumerate(g['projs']): outs.append((f'y{n}', self.fc(sg, x, p, 1, f'{key}{n}', p['s_out'])))
        self.signature(key, [('x', x)], outs, sg)
    def chained(self, key, g):
        ch = g['chain']; prev = ch['prev']; p1 = prev['projs'][0]; sg = S.SubGraphT(); sg.name = key.encode(); sg.tensors = []; sg.operators = []
        a = self.tensor(sg, 'a', A16, [1, prev['n_in']], prev['s_in']); s1 = float(p1['s_out'])
        c0 = self.tensor(sg, 'c0', A16, [1, g['n_in']], s1); c1 = self.tensor(sg, 'c1', A16, [1, g['n_in']], s1); xs = self.tensor(sg, 'xs', A16, [1, g['n_in']], s1)
        yo = self.fc(sg, a, p1, 1, key + '_p', s1)
        z = self.tensor(sg, 'z', A16, [1, g['n_in']], s1); self.op(sg, S.BuiltinOperator.ADD, [yo, c0], [z], 1, S.AddOptionsT(), S.BuiltinOptions.AddOptions)
        cv = self.tensor(sg, 'mR', A16, [g['n_in']], 1.0, ch['mR'].tobytes()); rb0 = self.tensor(sg, 'rb0', A16, [1, g['n_in']], s1)
        self.op(sg, S.BuiltinOperator.MUL, [z, cv], [rb0], 1, S.MulOptionsT(), S.BuiltinOptions.MulOptions)
        rb = self.tensor(sg, 'rb', A16, [1, g['n_in']], s1); self.op(sg, S.BuiltinOperator.ADD, [rb0, c1], [rb], 1, S.AddOptionsT(), S.BuiltinOptions.AddOptions)
        cat = self.tensor(sg, 'cat', A16, [2, g['n_in']], s1); co = S.ConcatenationOptionsT(); co.axis = 0; self.op(sg, S.BuiltinOperator.CONCATENATION, [xs, rb], [cat], 1, co, S.BuiltinOptions.ConcatenationOptions)
        outs = [('y0', yo)]
        for n, p in enumerate(g['projs']): outs.append((f'y{n + 1}', self.fc(sg, cat, p, 2, f'{key}{n}', s1 * float(ch['c0']))))   # M_j = s1 * sw_j / (s1 * c0) = sw_j / c0
        self.signature(key, [('a', a), ('c0', c0), ('c1', c1), ('xs', xs)], outs, sg)

def pad8(f): f.write(b'\0' * (-f.tell() % 8))
def write_group(f, g):
    f.write(struct.pack('<HBBIff', g['layer'], g['kind'], len(g['projs']), g['n_in'], float(g['s_in']), A.k))
    f.write(g['s'].tobytes()); f.write(g['sig_q'].tobytes()); f.write(g['r_amp'].tobytes()); pad8(f)
    for p in g['projs']:
        f.write(p['name'].encode().ljust(64, b'\0')); f.write(struct.pack('<Ifi', p['Wq'].shape[0], float(p['s_out']), p['budget']))
        f.write(p['sw'].tobytes()); f.write(p['Wq'].tobytes()); pad8(f)
    if g['chain'] is not None:
        ch = g['chain']; n = g['n_in']
        f.write(struct.pack('<BBHfff', ch['prev']['kind'], 1, len(ch['heavy']), float(ch['s_inR']), float(ch['c0']), float(ch['osc'])))
        f.write(ch['mR'].tobytes()); f.write(ch['ampR'].tobytes()); f.write(ch['gains1'].tobytes()); f.write(ch['gains2'].tobytes()); f.write(ch['heavy'].tobytes()); pad8(f)
        for p in g['projs']: f.write(struct.pack('<i', p['budgetB'])); f.write(p['Wcol'].tobytes()); pad8(f)

groups = []
for L in want:
    b = Builder(); here = []
    if L == 0: g = plain_group(0, 0, ['attn_q', 'attn_k', 'attn_v']); here.append(g); b.plain('qkv', g)
    go = plain_group(L, 1, ['attn_output']); gd = plain_group(L, 3, ['ffn_down']); here += [go, gd]
    g = chain_group(L, 4, go, ['ffn_gate', 'ffn_up'], vec(f'blk.{L}.post_attention_norm.weight'), vec(f'blk.{L}.ffn_norm.weight'), 0.0, L); here.append(g); b.chained('ogu', g)
    if L + 1 < n_layer:
        g = chain_group(L, 5, gd, ['attn_q', 'attn_k', 'attn_v'], vec(f'blk.{L}.post_ffw_norm.weight'), vec(f'blk.{L + 1}.attn_norm.weight'), float(vec(f'blk.{L}.layer_output_scale.weight')[0]), L + 1)
        here.append(g); b.chained('dq', g)
    else: b.plain('down', gd)
    groups += here; fu.write_model(b.m, f'{A.outdir}/L{L}.tflite')
    print(f'L{L}: {os.path.getsize(f"{A.outdir}/L{L}.tflite") >> 20} MB, ' + ', '.join(f"k{g['kind']}[{'+'.join(p['name'].split('.')[2] for p in g['projs'])}]" + (f" heavy={len(g['chain']['heavy'])} s_inR={float(g['chain']['s_inR']):.3g} c0={float(g['chain']['c0']):.3g}" if g['chain'] else '') for g in here), flush=True)
with open(f'{A.outdir}/lanes.etpu', 'wb') as f:
    f.write(b'ETPUB002' + struct.pack('<I', len(groups))); pad8(f)
    for g in groups: write_group(f, g)
print(f'bundle: {A.outdir}/lanes.etpu {os.path.getsize(A.outdir + "/lanes.etpu") >> 20} MB, {len(groups)} groups, k={A.k}, alpha={A.alpha}, heavy={A.heavy}')
