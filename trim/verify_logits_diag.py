"""Isolate where logit differences come from.
MODE=same_gpu_fp16 : original + trimmed both on cuda:0 in fp16 (pure row-mapping test at the spec's precision)
MODE=ctrl_fp16     : original on cuda:0 vs the SAME original on cuda:1 in fp16 (hardware/kernel control)
MODE=cross_fp32    : original cuda:0 vs trimmed cuda:1 in fp32"""
import os, sys, glob, json, random, numpy as np, torch
from transformers import AutoTokenizer, Gemma4ForConditionalGeneration
HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = glob.glob(os.path.expanduser("~/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/*/"))[0]
OUT = os.path.join(HERE, "..", "gemma-4-E2B-it-en-code")
MODE = os.environ["MODE"]; N = int(os.environ.get("N", "100")); MAXLEN = 384
id_map = {int(k): v for k, v in json.load(open(os.path.join(HERE, "artifacts", "id_map_old_to_new.json"))).items()}
keep = torch.tensor(sorted(id_map), dtype=torch.long)
to = AutoTokenizer.from_pretrained(SNAP)
dt = torch.float32 if "fp32" in MODE else torch.float16
if MODE == "same_gpu_fp16": paths, devs = (SNAP, OUT), (0, 0)
elif MODE == "ctrl_fp16":   paths, devs = (SNAP, SNAP), (0, 1)
else:                       paths, devs = (SNAP, OUT), (0, 1)
ma = Gemma4ForConditionalGeneration.from_pretrained(paths[0], dtype=dt, device_map={"": devs[0]}, attn_implementation="eager").eval()
mb = Gemma4ForConditionalGeneration.from_pretrained(paths[1], dtype=dt, device_map={"": devs[1]}, attn_implementation="eager").eval()
trimmed_b = paths[1] == OUT
docs = []
for f in sorted(glob.glob(os.path.join(HERE, "corpus", "heldout", "*.jsonl"))):
    for line in open(f): docs.append(json.loads(line))
random.Random(0).shuffle(docs)
rows = []
for kind in ("english", "code"):
    used = 0
    for r in (d for d in docs if d["kind"] == kind):
        ids = to.encode(r["text"][:6000], add_special_tokens=False)[:MAXLEN]
        if any(i not in id_map for i in ids): continue
        xa = torch.tensor([[to.bos_token_id] + ids], device=f"cuda:{devs[0]}")
        xb = torch.tensor([[to.bos_token_id] + ([id_map[i] for i in ids] if trimmed_b else ids)], device=f"cuda:{devs[1]}")
        with torch.no_grad():
            oa = ma(input_ids=xa, output_hidden_states=True); ob = mb(input_ids=xb, output_hidden_states=True)
        la = oa.logits[0].float().cpu()[:, keep]
        lb = ob.logits[0].float().cpu(); lb = lb[:, keep] if not trimmed_b else lb
        ha, hb = oa.hidden_states[-1][0].float().cpu(), ob.hidden_states[-1][0].float().cpu()
        rows.append((kind, (la - lb).abs().max().item(), (ha - hb).abs().max().item(), (la.argmax(-1) == lb.argmax(-1)).float().mean().item(), len(ids) + 1))
        used += 1
        if used >= N: break
res = {}
for kind in ("english", "code"):
    a = np.array([r[1:] for r in rows if r[0] == kind])
    res[kind] = {"prompts": int(len(a)), "positions": int(a[:, 3].sum()), "max_abs_diff_logits": float(a[:, 0].max()), "max_abs_diff_last_hidden": float(a[:, 1].max()),
                 "argmax_agreement": float(a[:, 2].mean()), "prompts_under_1e-3": int((a[:, 0] < 1e-3).sum()), "prompts_exact_zero": int((a[:, 0] == 0).sum())}
print(MODE, json.dumps(res, indent=1))
json.dump(res, open(os.path.join(HERE, "artifacts", f"verify_logits_{MODE}.json"), "w"), indent=1)
