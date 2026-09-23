#!/usr/bin/env python3
"""mac_share.py <lanes.etpu> <model.gguf> [ctx ...] -- where a decoded token's multiply-accumulates happen.

The offload share has been quoted as "35 of 35 blocks", which counts layers, not work. This counts MACs per
decoded row, from the two files that decide them: the lane bundle (every projection the TPU is sent) and the
GGUF (every other matmul, and the attention shapes). Nothing is estimated from parameter totals.

Per decoded row:
  TPU            sum over the bundle of n_out * n_in    (the useful product; digit-split sends 2 rows of int8
                                                          digits, so the TPU physically does twice this)
  VM, online     lm_head (token_embd, tied), per_layer_model_proj, each block's inp_gate and proj (the per-layer
                 embedding path), and attention (QK^T and AV) at the given context
  VM, pads       one pad per row per group costs sum_j n_out*n_in again: the same integer MACs as the product it
                 protects. Minted before decode (the bank) or inside it (inline/window) -- either way on the VM.

It needs gguf-py on PYTHONPATH (llama.cpp's gguf-py).
"""
import os, struct, sys

import gguf


def bundle_macs(path):
    """Sum n_out*n_in over every projection, seeking past the payload arrays."""
    macs = 0; groups = 0; per_kind = {}; layers = set()
    with open(path, 'rb') as f:
        magic = f.read(8).decode(); ng, = struct.unpack('<I', f.read(4))
        def pad8(): f.seek((f.tell() + 7) & ~7)
        pad8()
        for _ in range(ng):
            layer, kind, nproj, n_in, _s_in, _k = struct.unpack('<HBBIff', f.read(16))
            f.seek(4 * n_in + 2 * n_in + 2 * n_in, 1); pad8()
            for _ in range(nproj):
                f.read(64); n_out, _s_out, _b = struct.unpack('<Ifi', f.read(12))
                f.seek(4 * n_out + n_out * n_in, 1); pad8()
                macs += n_out * n_in; per_kind[kind] = per_kind.get(kind, 0) + n_out * n_in
            groups += 1; layers.add(layer)
    return magic, groups, layers, macs, per_kind


def field(r, key):
    f = r.fields[key]
    if f.types and f.types[0] == gguf.GGUFValueType.STRING:
        return bytes(f.parts[f.data[0]]).decode()
    vals = [f.parts[i].tolist() for i in f.data]
    vals = [v[0] if isinstance(v, list) and len(v) == 1 else v for v in vals]
    return vals if len(f.data) > 1 else vals[0]


def main():
    if len(sys.argv) < 3:
        print(__doc__); return 2
    bundle, model = sys.argv[1], sys.argv[2]
    ctxs = [int(c) for c in sys.argv[3:]] or [128, 512, 2048]
    magic, groups, layers, tpu, per_kind = bundle_macs(bundle)
    r = gguf.GGUFReader(model)
    arch = field(r, 'general.architecture')
    n_layer = field(r, f'{arch}.block_count'); n_head = field(r, f'{arch}.attention.head_count')
    k_full = field(r, f'{arch}.attention.key_length'); k_swa = field(r, f'{arch}.attention.key_length_swa')
    window = field(r, f'{arch}.attention.sliding_window'); pattern = field(r, f'{arch}.attention.sliding_window_pattern')
    shapes = {t.name: [int(v) for v in t.shape] for t in r.tensors}
    def mm(name):   # GGUF lists ne0 first: [n_in, n_out]
        s = shapes[name]; return s[0] * s[1]
    lm_head = mm('output.weight') if 'output.weight' in shapes else mm('token_embd.weight')
    ple_in = mm('per_layer_model_proj.weight') if 'per_layer_model_proj.weight' in shapes else 0
    ple_blk = sum(mm(f'blk.{i}.{n}.weight') for i in range(n_layer) for n in ('inp_gate', 'proj')
                  if f'blk.{i}.{n}.weight' in shapes)
    # every projection the bundle does NOT carry, so a partial bundle leaves the rest on the VM
    offloaded = {0: ('attn_q', 'attn_k', 'attn_v'), 1: ('attn_output',), 2: ('ffn_gate', 'ffn_up'), 3: ('ffn_down',)}
    # KV-shared blocks (the last `shared_kv_layers`) reuse an earlier block's K and V: their attn_k/attn_v tensors
    # are in the file but never multiplied, so they are not work anyone does
    shared = field(r, f'{arch}.attention.shared_kv_layers') if f'{arch}.attention.shared_kv_layers' in r.fields else 0
    computed = lambda i, n: not (n in ('attn_k', 'attn_v') and i >= n_layer - shared)
    proj_all = sum(mm(f'blk.{i}.{n}.weight') for i in range(n_layer) for ns in offloaded.values() for n in ns
                   if f'blk.{i}.{n}.weight' in shapes and computed(i, n))
    proj_left = proj_all - tpu
    print(f"bundle {os.path.basename(bundle)}: {magic}, {groups} groups over {len(layers)} of {n_layer} blocks")
    print(f"  projections in the model {proj_all:,} MACs/row; on the TPU {tpu:,} ({100 * tpu / proj_all:.1f} %)")
    kinds = {0: 'qkv', 1: 'o', 2: 'gate+up', 3: 'down'}
    print("  by kind: " + ", ".join(f"{kinds[k]} {v / 1e6:.1f}M" for k, v in sorted(per_kind.items())))
    print(f"  VM matmuls outside the blocks: lm_head {lm_head / 1e6:.1f}M, per-layer embedding in {ple_in / 1e6:.1f}M, "
          f"per-block inp_gate+proj {ple_blk / 1e6:.1f}M, projections not in the bundle {proj_left / 1e6:.1f}M")
    print(f"{'ctx':>6} {'TPU':>9} {'VM online':>10} {'attention':>10} {'TPU share online':>17} {'VM pads':>9} {'TPU share incl. pads':>21}")
    for c in ctxs:
        att = 0
        for i in range(n_layer):
            swa = bool(pattern[i]) if isinstance(pattern, list) else False
            kd = k_swa if swa else k_full; span = min(c, window) if swa else c
            att += 2 * n_head * kd * span
        vm = lm_head + ple_in + ple_blk + proj_left + att
        pads = tpu
        print(f"{c:>6} {tpu / 1e6:>8.1f}M {vm / 1e6:>9.1f}M {att / 1e6:>9.1f}M {100 * tpu / (tpu + vm):>16.1f}% "
              f"{pads / 1e6:>8.1f}M {100 * tpu / (tpu + vm + pads):>20.1f}%")
    return 0


if __name__ == '__main__':
    sys.exit(main())
