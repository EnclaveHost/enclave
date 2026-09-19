#!/usr/bin/env python3
"""calibrate.py <hf-model-dir> <out.npz> [text files...] -- activation statistics for the Shielded-TPU lanes (TPU.md).

Runs the fp32 checkpoint on real chats (prompt + the model's own reply) and records, for every attention/MLP projection,
the per-input-channel quantile of |x| (the signal lane: entries beyond it never leave the VM) and the largest |W x| seen
(the output lane's signal part). Keys are GGUF tensor names (blk.N.attn_q.weight ...), because the lanes are consumed by
the llama.cpp graph inside the VM. Public data: nothing here depends on a user's prompt."""
import sys, re, numpy as np, torch
from transformers import AutoTokenizer, AutoModelForCausalLM
src, out = sys.argv[1], sys.argv[2]; files = sys.argv[3:]
Q = 0.999
NAMES = {'self_attn.q_proj': 'attn_q', 'self_attn.k_proj': 'attn_k', 'self_attn.v_proj': 'attn_v', 'self_attn.o_proj': 'attn_output',
         'mlp.gate_proj': 'ffn_gate', 'mlp.up_proj': 'ffn_up', 'mlp.down_proj': 'ffn_down'}
tok = AutoTokenizer.from_pretrained(src); model = AutoModelForCausalLM.from_pretrained(src, dtype=torch.float32).eval()
texts = [open(f).read()[:6000] for f in files] or ["Explain how a bill becomes law.", "Write a Python function that parses a CSV file and explain it.",
         "Explique la photosynthese, then compute 17*23 step by step.", "Who was Marie Curie?", "Summarize the history of the bicycle in 200 words."]
acts, outs, stat = {}, {}, {}
def hook(key):
    def f(mod, inp, o):
        acts.setdefault(key, []).append(inp[0].detach().reshape(-1, inp[0].shape[-1]).abs().float()); outs[key] = max(outs.get(key, 0.0), o.detach().abs().max().item())
    return f
for n, m in model.named_modules():
    mm = re.search(r'language_model\.layers\.(\d+)\.(self_attn\.[qkvo]_proj|mlp\.(?:gate|up|down)_proj)$', n)
    if mm and isinstance(m, torch.nn.Linear): m.register_forward_hook(hook(f'blk.{mm.group(1)}.{NAMES[mm.group(2)]}.weight'))
# The chained exchanges (TPU.md "Can a mask survive the nonlinear steps?"): per block, row A = g_f * x / rms(x) (merge A) and
# g_a' * h0 / rms(h0) (merge B), row B = g_f*g_pa * o and g_a'*g_pf * d; per-channel quantile/max of row A, per-channel max of row B,
# and the largest |W row| for each projection and row. Keys: chain.<layer>.<gu|qkv>.<A_q|A_max|B_max> and chain.<layer>.<gu|qkv>.<proj>.<outA|outB>
LAYERS = model.model.language_model.layers; cap = {}; chain = {}
def capin(key):
    def f(mod, args, kwargs): cap[key] = (args[0] if args else kwargs['hidden_states']).detach().reshape(-1, (args[0] if args else kwargs['hidden_states']).shape[-1]).double()
    return f
def capout(key):
    def f(mod, inp, o): cap[key] = o.detach().reshape(-1, o.shape[-1]).double()
    return f
for L, ly in enumerate(LAYERS):
    ly.register_forward_pre_hook(capin(('x', L)), with_kwargs=True); ly.self_attn.o_proj.register_forward_hook(capout(('o', L)))
    ly.pre_feedforward_layernorm.register_forward_pre_hook(lambda m, a, L=L: cap.__setitem__(('h0', L), a[0].detach().reshape(-1, a[0].shape[-1]).double())); ly.mlp.down_proj.register_forward_hook(capout(('d', L)))
def upd(k, v): chain[k] = torch.maximum(chain[k], v) if k in chain else v
rms_inv = lambda v: (v.pow(2).mean(-1, keepdim=True) + 1e-6).pow(-0.5)
def chain_stats():
    for L, ly in enumerate(LAYERS):
        gf, gpa, gpf = ly.pre_feedforward_layernorm.weight.detach().double(), ly.post_attention_layernorm.weight.detach().double(), ly.post_feedforward_layernorm.weight.detach().double()
        x, o, h0, d = cap[('x', L)], cap[('o', L)], cap[('h0', L)], cap[('d', L)]
        merges = [('gu', gf * x * rms_inv(x), gf * gpa * o, [('ffn_gate', ly.mlp.gate_proj), ('ffn_up', ly.mlp.up_proj)], L)]
        if L + 1 < len(LAYERS):
            nx = LAYERS[L + 1]; ga = nx.input_layernorm.weight.detach().double()
            merges.append(('qkv', ga * h0 * rms_inv(h0), ga * gpf * d, [(n, getattr(nx.self_attn, at, None)) for n, at in (('attn_q', 'q_proj'), ('attn_k', 'k_proj'), ('attn_v', 'v_proj'))], L + 1))
        for kind, rowA, rowB, projs, Lk in merges:
            aA = rowA.abs(); upd(f'chain.{Lk}.{kind}.A_q', torch.quantile(aA.float(), Q, dim=0).double()); upd(f'chain.{Lk}.{kind}.A_max', aA.amax(0)); upd(f'chain.{Lk}.{kind}.B_max', rowB.abs().amax(0))
            for nm, lin in projs:
                if lin is None: continue
                Wt = lin.weight.detach().double().T; upd(f'chain.{Lk}.{kind}.{nm}.outA', (rowA @ Wt).abs().max()); upd(f'chain.{Lk}.{kind}.{nm}.outB', (rowB @ Wt).abs().max())
    cap.clear()
for t in texts:
    ids = tok.apply_chat_template([{"role": "user", "content": t}], add_generation_prompt=True, return_tensors='pt', return_dict=True)
    with torch.no_grad():
        full = model.generate(**ids, max_new_tokens=128, do_sample=False); acts.clear(); model(input_ids=full)
    for k, v in acts.items():
        a = v[0]; q = torch.quantile(a, Q, dim=0); mx = a.amax(0)
        s = stat.setdefault(k, {'q': torch.zeros_like(q), 'max': torch.zeros_like(mx)}); s['q'] = torch.maximum(s['q'], q); s['max'] = torch.maximum(s['max'], mx)
    chain_stats(); acts.clear(); print('calibrated on', full.shape[1], 'tokens', flush=True)
np.savez(out, **{k + '|q': v['q'].numpy() for k, v in stat.items()}, **{k + '|max': v['max'].numpy() for k, v in stat.items()}, **{k + '|out': np.float32(outs[k]) for k in stat}, **{k: v.float().numpy() for k, v in chain.items()})
print('CALIBRATION_DONE', len(stat), 'projections ->', out)
