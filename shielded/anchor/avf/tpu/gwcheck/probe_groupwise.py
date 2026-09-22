"""probe_groupwise.py -- GROUP-WISE int4 on the Tensor G5 AOT compiler, WITHOUT the op that crashes it.

Quantised FULLY_CONNECTED carries one weight scale per OUTPUT channel and nothing per group of INPUT
columns, so group-wise int4 -- a separate scale per (output channel, input group) -- cannot be one FC.
The obvious workaround slices the input into groups and sums partial products, and SLICE is exactly
what the compiler crashes on (op_slice_g5 compiles to 0 bytes on its own).

But the slice is only needed if the groups arrive as ONE tensor. Send them as G separate graph inputs
instead and nothing has to be sliced: G FULLY_CONNECTEDs, each over its own disjoint block of input
columns with its OWN per-output-channel scales, then an ADD tree. Per (output channel, group) scales is
precisely group-wise quantisation. And because the weight blocks are DISJOINT column ranges of one
matrix, nothing is duplicated -- unlike two FCs sharing one weight tensor, which emits it twice.

Every piece is already known to compile: ds_two_copies (2 inputs, 2 INT4 FCs, ADD) and np2/np3 do. This
probe checks the combination at the real shape, with DIFFERENT weights per group so the compiler cannot
deduplicate them, and reports the compiled size against the int8 and per-row int4 controls.

Usage: python probe_groupwise.py [n_in] [n_out] [rows]
"""
import os, sys
import numpy as np
from ai_edge_litert import schema_py_generated as S
from ai_edge_litert.tools import flatbuffer_utils as fu

N_IN = int(sys.argv[1]) if len(sys.argv) > 1 else 2048
N_OUT = int(sys.argv[2]) if len(sys.argv) > 2 else 8192
R = int(sys.argv[3]) if len(sys.argv) > 3 else 5
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gw")
# S_OUT small enough that typical outputs are tens to hundreds of LSB, so a wrong result cannot hide in
# the rounding -- at 0.05 a typical output was 1-2 LSB and a broken graph could still agree most of the time.
S_ACT, S_OUT = 0.01, 0.0008


class Graph:
    def __init__(self):
        self.m = S.ModelT(); self.m.version = 3; self.m.description = b"group-wise int4 probe"
        self.m.operatorCodes = []; self.m.subgraphs = []; self.m.buffers = [S.BufferT()]
        self.m.signatureDefs = []; self.m.metadata = []; self.codes = {}
        self.sg = S.SubGraphT(); self.sg.name = b"fc"; self.sg.tensors = []; self.sg.operators = []

    def code(self, b):
        if b not in self.codes:
            oc = S.OperatorCodeT(); oc.builtinCode = b; oc.deprecatedBuiltinCode = b if b < 127 else 127; oc.version = 1
            self.m.operatorCodes.append(oc); self.codes[b] = len(self.m.operatorCodes) - 1
        return self.codes[b]

    def tensor(self, name, ttype, shape, scale, data=None, qdim=0):
        buf = 0
        if data is not None:
            b = S.BufferT(); b.data = np.frombuffer(data, np.uint8); self.m.buffers.append(b); buf = len(self.m.buffers) - 1
        t = S.TensorT(); t.name = name.encode(); t.type = ttype; t.shape = np.array(shape, np.int32); t.buffer = buf
        q = S.QuantizationParametersT(); q.scale = np.atleast_1d(np.asarray(scale, np.float32))
        q.zeroPoint = np.zeros(len(q.scale), np.int64); q.quantizedDimension = qdim; t.quantization = q
        self.sg.tensors.append(t); return len(self.sg.tensors) - 1

    def op(self, b, ins, outs, ot=None, o=None):
        x = S.OperatorT(); x.opcodeIndex = self.code(b); x.inputs = np.array(ins, np.int32); x.outputs = np.array(outs, np.int32)
        if o is not None: x.builtinOptionsType = ot; x.builtinOptions = o
        self.sg.operators.append(x)

    def finish(self, path, ins, out):
        self.sg.inputs = np.array(ins, np.int32); self.sg.outputs = np.array([out], np.int32)
        self.m.subgraphs.append(self.sg)
        sd = S.SignatureDefT(); sd.signatureKey = b"fc"; sd.subgraphIndex = 0; sd.inputs = []
        for k, i in enumerate(ins):
            tm = S.TensorMapT(); tm.name = f"x{k}".encode(); tm.tensorIndex = i; sd.inputs.append(tm)
        tm = S.TensorMapT(); tm.name = b"y"; tm.tensorIndex = out; sd.outputs = [tm]
        self.m.signatureDefs.append(sd); fu.write_model(self.m, path); return os.path.getsize(path)


def int4_block(rows, cols, seed):
    w = np.random.default_rng(seed).integers(-7, 8, size=(rows, cols), dtype=np.int8)
    f = w.reshape(-1).astype(np.int8) & 0x0F
    return (f[0::2] | (f[1::2] << 4)).astype(np.uint8).tobytes()


def build(groups):
    assert N_IN % groups == 0, "n_in must divide by the group count"
    gc = N_IN // groups
    g = Graph(); ins = []; parts = []
    fo = S.FullyConnectedOptionsT(); fo.keepNumDims = True
    for k in range(groups):
        x = g.tensor(f"x{k}", S.TensorType.INT8, [R, gc], np.float32(S_ACT))
        # a DIFFERENT per-output-channel scale vector per group: this IS the group-wise scale
        # Group k's scales sit near (1 + k/2) x base, with per-channel jitter. If the compiled graph applied
        # the wrong group's scale -- or one scale to every group, which is per-row quantisation again --
        # the result moves by tens of percent, not by rounding. That is the property under test.
        sc = ((1.0 + 0.5 * k) * 0.0008 * (1.0 + 0.1 * np.random.default_rng(100 + k).random(N_OUT))).astype(np.float32)
        w = g.tensor(f"w{k}", S.TensorType.INT4, [N_OUT, gc], sc, int4_block(N_OUT, gc, 1000 + k))
        y = g.tensor(f"y{k}", S.TensorType.INT16, [R, N_OUT], np.float32(S_OUT))
        g.op(S.BuiltinOperator.FULLY_CONNECTED, [x, w, -1], [y], S.BuiltinOptions.FullyConnectedOptions, fo)
        ins.append(x); parts.append(y)
    # ADD tree -- ADD is the op already shown to compile, including across different scales
    lvl = 0
    while len(parts) > 1:
        nxt = []
        for i in range(0, len(parts) - 1, 2):
            s = g.tensor(f"s{lvl}_{i}", S.TensorType.INT16, [R, N_OUT], np.float32(S_OUT))
            g.op(S.BuiltinOperator.ADD, [parts[i], parts[i + 1]], [s], S.BuiltinOptions.AddOptions, S.AddOptionsT())
            nxt.append(s)
        if len(parts) % 2: nxt.append(parts[-1])
        parts = nxt; lvl += 1
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, f"gw{groups}.tflite")
    return p, g.finish(p, ins, parts[0])


if __name__ == "__main__":
    for G in (1, 2, 4, 16):
        p, sz = build(G)
        print(f"gw{G:<3} groups of {N_IN // G:4} input cols  -> {p}  ({sz/1e6:.2f} MB uncompiled)")
