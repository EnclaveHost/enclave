"""Load the original model on the GPU, slice the vocab-sized tables by keep_ids, fix configs, save_pretrained.
Tensors are indexed (no arithmetic) in the checkpoint's own bf16 so every non-vocab tensor stays byte-identical."""
import os, glob, json, re, sys, time, shutil, numpy as np, torch
from torch import nn
from transformers import Gemma4ForConditionalGeneration, AutoProcessor
HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = glob.glob(os.path.expanduser("~/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/*/"))[0]
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "gemma-4-E2B-it-en-code")
keep = torch.from_numpy(np.load(os.path.join(HERE, "artifacts", "keep_ids.npy")))
id_map = {int(o): n for n, o in enumerate(keep.tolist())}
t0 = time.time()
model = Gemma4ForConditionalGeneration.from_pretrained(SNAP, dtype=torch.bfloat16, device_map={"": 0})
print(f"loaded in {time.time()-t0:.0f}s on", next(model.parameters()).device)
lm = model.model.language_model
emb, ple = lm.embed_tokens, lm.embed_tokens_per_layer
tied = model.lm_head.weight.data_ptr() == emb.weight.data_ptr()
print("lm_head tied to embed_tokens:", tied, "| tie_word_embeddings:", model.config.text_config.tie_word_embeddings)
n_total_before = sum(p.numel() for p in model.parameters())
n_emb_before = emb.weight.numel() + ple.weight.numel() + (0 if tied else model.lm_head.weight.numel())
vocab_sized = [(n, tuple(p.shape)) for n, p in model.named_parameters() if 262144 in p.shape]
print("vocab-sized parameters:", vocab_sized)
assert {n for n, _ in vocab_sized} <= {"model.language_model.embed_tokens.weight", "model.language_model.embed_tokens_per_layer.weight", "lm_head.weight"}, vocab_sized
kd = keep.to(emb.weight.device)
with torch.no_grad():
    for mod in (emb, ple):
        w = mod.weight.data.index_select(0, kd).clone()
        mod.weight = nn.Parameter(w, requires_grad=False); mod.num_embeddings = w.shape[0]
        assert mod.padding_idx in (None, 0) and id_map.get(0) == 0
    if tied:
        model.lm_head.weight = emb.weight
    else:
        model.lm_head.weight = nn.Parameter(model.lm_head.weight.data.index_select(0, kd).clone(), requires_grad=False)
    model.lm_head.out_features = len(keep)
NV = len(keep)
for obj in (model, model.model, lm): obj.vocab_size = NV
model.model.vocab_size_per_layer_input = NV
tc = model.config.text_config
tc.vocab_size = NV; tc.vocab_size_per_layer_input = NV
def remap(obj, path=""):
    d = obj if isinstance(obj, dict) else obj.__dict__
    for k, v in list(d.items()):
        if re.search(r"token_(id|index)$", k) and v is not None:
            if isinstance(v, list): nv = [id_map[x] for x in v]
            elif isinstance(v, int): nv = id_map[v]
            else: continue
            print(f"  {path}{k}: {v} -> {nv}")
            if isinstance(obj, dict): obj[k] = nv
            else: setattr(obj, k, nv)
        elif hasattr(v, "__dict__") and k in ("text_config",): remap(v, path + k + ".")
print("config id fields:"); remap(model.config); remap(model.config.text_config, "text_config.")
print("generation_config id fields:"); remap(model.generation_config, "generation_config.")
model.config.dtype = torch.bfloat16
n_total_after = sum(p.numel() for p in model.parameters())
n_emb_after = emb.weight.numel() + ple.weight.numel() + (0 if tied else model.lm_head.weight.numel())
os.makedirs(OUT, exist_ok=True)
model.save_pretrained(OUT, safe_serialization=True)
shutil.copy(os.path.join(SNAP, "processor_config.json"), OUT)
stats = {"vocab_before": 262144, "vocab_after": NV, "params_total_before": n_total_before, "params_total_after": n_total_after,
         "params_embedding_before": n_emb_before, "params_embedding_after": n_emb_after, "tied": tied,
         "disk_before_bytes": sum(os.path.getsize(os.path.join(SNAP, f)) for f in os.listdir(SNAP) if not f.startswith(".")),
         "disk_after_bytes": sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))}
json.dump(stats, open(os.path.join(HERE, "artifacts", "slice_stats.json"), "w"), indent=1)
print(json.dumps(stats, indent=1)); print(f"saved to {OUT} in {time.time()-t0:.0f}s")
