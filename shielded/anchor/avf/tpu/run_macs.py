#!/usr/bin/env python3
"""run_macs.py <model.gguf> <drafter.gguf> <run.log> ... -- where a RUN's decode multiply-accumulates happened.

mac_share.py gives the split per decoded ROW with no drafter. A speculative run verifies (drafted + steps) rows through the
target model and runs the drafter once per drafted token, so the split of a whole run follows from its own STATS line:
  rows      = drafted + steps                    (each step verifies its proposals plus one row)
  TPU       = rows x the block projections        (every one of them: a run's exchanges must equal 140 x steps)
  VM online = rows x (lm_head + per-layer-embedding matmuls + attention at the run's mean decode context)
              + drafted x the drafter's matmuls   (its 4 blocks, pre/post projection and its vocab-wide head)
  VM pads   = rows x the block projections        (one pad per verified row, minted into the bank before decode)
The drafter's attention (against the target's cache) is left out: 4 heads' worth at ctx <= a few hundred, < 1 M per
proposal. Needs gguf-py on PYTHONPATH."""
import re, sys

import gguf

def field(r, key):
    f = r.fields[key]
    if f.types and f.types[0] == gguf.GGUFValueType.STRING:
        return bytes(f.parts[f.data[0]]).decode()
    vals = [f.parts[i].tolist() for i in f.data]
    vals = [v[0] if isinstance(v, list) and len(v) == 1 else v for v in vals]
    return vals if len(f.data) > 1 else vals[0]

def target(path):
    r = gguf.GGUFReader(path); a = field(r, 'general.architecture')
    sh = {t.name: [int(v) for v in t.shape] for t in r.tensors}; mm = lambda n: sh[n][0] * sh[n][1]
    L = field(r, f'{a}.block_count'); shared = field(r, f'{a}.attention.shared_kv_layers')
    proj = sum(mm(f'blk.{i}.{n}.weight') for i in range(L)
               for n in ('attn_q', 'attn_k', 'attn_v', 'attn_output', 'ffn_gate', 'ffn_up', 'ffn_down')
               if f'blk.{i}.{n}.weight' in sh and not (n in ('attn_k', 'attn_v') and i >= L - shared))
    lm = mm('output.weight') if 'output.weight' in sh else mm('token_embd.weight')
    ple = (mm('per_layer_model_proj.weight') if 'per_layer_model_proj.weight' in sh else 0) + \
          sum(mm(f'blk.{i}.{n}.weight') for i in range(L) for n in ('inp_gate', 'proj') if f'blk.{i}.{n}.weight' in sh)
    geo = (L, field(r, f'{a}.attention.head_count'), field(r, f'{a}.attention.key_length'),
           field(r, f'{a}.attention.key_length_swa'), field(r, f'{a}.attention.sliding_window'),
           field(r, f'{a}.attention.sliding_window_pattern'))
    return proj, lm + ple, geo

def attention(geo, c):
    L, H, kf, ks, win, pat = geo
    return sum(2 * H * (ks if pat[i] else kf) * (min(c, win) if pat[i] else c) for i in range(L))

def drafter(path):
    r = gguf.GGUFReader(path)
    return sum(int(t.shape[0]) * int(t.shape[1]) for t in r.tensors
               if len(t.shape) == 2 and t.name != 'rope_freqs.weight')   # token_embd is its tied vocab head

def main():
    if len(sys.argv) < 4: print(__doc__); return 2
    proj, fixed, geo = target(sys.argv[1]); dr = drafter(sys.argv[2])
    print(f"per row: block projections {proj/1e6:.1f}M (TPU), lm_head+PLE {fixed/1e6:.1f}M (VM); drafter {dr/1e6:.1f}M per proposal (VM)")
    print("run\tdecode_tok\tsteps\tdrafted\trows\texchanges\tTPU_M\tVM_online_M\tTPU_share_online\tTPU_share_incl_pads\tTPU_M_per_token")
    for p in sys.argv[3:]:
        t = open(p, errors='replace').read()
        m = re.search(r'LOCAL turn 1 STATS \{([^}]*)\}', t)
        if not m: print(f"{p}\tNO STATS"); continue
        s = dict(kv.split('=', 1) for kv in m.group(1).split(', '))
        dec, pre = int(s['decode_tokens']), int(s['prefill_tokens'])
        steps = int(s.get('steps', dec)); drafted = int(s.get('drafted', 0)); rows = steps + drafted
        ex = re.search(r'exchanges=(\d+)', t); ex = int(ex.group(1)) if ex else -1
        ctx = pre + dec / 2
        tpu = rows * proj; vm = rows * (fixed + attention(geo, ctx)) + drafted * dr
        print(f"{p.split('/')[-1]}\t{dec}\t{steps}\t{drafted}\t{rows}\t{ex}\t{tpu/1e6:.0f}\t{vm/1e6:.0f}\t"
              f"{100*tpu/(tpu+vm):.1f}%\t{100*tpu/(2*tpu+vm):.1f}%\t{tpu/1e6/dec:.0f}")
    return 0

if __name__ == '__main__':
    sys.exit(main())
