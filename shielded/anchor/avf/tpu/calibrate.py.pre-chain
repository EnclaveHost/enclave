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
for t in texts:
    ids = tok.apply_chat_template([{"role": "user", "content": t}], add_generation_prompt=True, return_tensors='pt', return_dict=True)
    with torch.no_grad():
        full = model.generate(**ids, max_new_tokens=128, do_sample=False); acts.clear(); model(input_ids=full)
    for k, v in acts.items():
        a = v[0]; q = torch.quantile(a, Q, dim=0); mx = a.amax(0)
        s = stat.setdefault(k, {'q': torch.zeros_like(q), 'max': torch.zeros_like(mx)}); s['q'] = torch.maximum(s['q'], q); s['max'] = torch.maximum(s['max'], mx)
    acts.clear(); print('calibrated on', full.shape[1], 'tokens', flush=True)
np.savez(out, **{k + '|q': v['q'].numpy() for k, v in stat.items()}, **{k + '|max': v['max'].numpy() for k, v in stat.items()}, **{k + '|out': np.float32(outs[k]) for k in stat})
print('CALIBRATION_DONE', len(stat), 'projections ->', out)
