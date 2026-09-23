"""Greedy answers + held-out perplexity for a full-size Gemma 4 E2B variant on the 8 GB RTX 3070.
The two embedding tables and the tied output head stay on the CPU (their forwards are patched); layers run on the GPU."""
import os, glob, json, math, random, sys, torch
from transformers import AutoTokenizer, Gemma4ForConditionalGeneration
HERE = os.path.dirname(os.path.abspath(__file__)); M = sys.argv[1]
tok = AutoTokenizer.from_pretrained(M)
model = Gemma4ForConditionalGeneration.from_pretrained(M, dtype=torch.float16, attn_implementation="eager").eval()
model.model.vision_tower = None; model.model.audio_tower = None
lm = model.model.language_model
emb, ple = lm.embed_tokens, lm.embed_tokens_per_layer
W = emb.weight.float().clone()                                    # tied head computed on CPU (fp32 copy)
lm.embed_tokens_per_layer = None; model.lm_head = None
lm.to("cuda:0"); model.model.embed_vision.to("cuda:0"); model.model.embed_audio.to("cuda:0")
lm.embed_tokens_per_layer = ple                                   # 4.4 GB table stays on the CPU
_ple_fwd = ple.forward; ple.forward = lambda ids, _f=_ple_fwd: _f(ids.cpu()).to("cuda:0")
class CPUHead(torch.nn.Module):
    weight = None
    def forward(self, h): return (h.float().cpu() @ W.T).to(h.device)
model.lm_head = CPUHead()
print("gpu mem GB after placement:", round(torch.cuda.memory_allocated() / 1e9, 2), flush=True)
for p in ["What is the capital of Australia?", "Write a Python function to check if a number is prime.", "Explain what a hash map is."]:
    x = tok.apply_chat_template([{"role": "user", "content": p}], add_generation_prompt=True, enable_thinking=False, return_tensors="pt", return_dict=True).to("cuda:0")
    with torch.no_grad(): g = model.generate(**x, max_new_tokens=60, do_sample=False)
    print(f"\n### {p}\n{tok.decode(g[0, x['input_ids'].shape[1]:], skip_special_tokens=True)}", flush=True)
docs = {"english": [], "code": []}
for f in sorted(glob.glob(os.path.join(HERE, "corpus", "heldout", "*.jsonl"))):
    for line in open(f):
        r = json.loads(line); docs[r["kind"]].append(r["text"])
for k in docs: random.Random(0).shuffle(docs[k])
for kind in docs:
    nll = ntok = nbytes = 0
    for d in docs[kind][:120]:
        ids = tok.encode(d[:8000], add_special_tokens=False)[:512]
        x = torch.tensor([[tok.bos_token_id] + ids], device="cuda:0")
        with torch.no_grad(): logits = model(input_ids=x).logits[0, :-1]
        nll += torch.nn.functional.cross_entropy(logits.float(), x[0, 1:], reduction="sum").item(); ntok += len(ids); nbytes += len(tok.decode(ids).encode("utf-8"))
    print(f"\nPPL {kind} (512-token windows, fp16 layers): token_ppl={math.exp(nll/ntok):.3f} bits_per_byte={nll/nbytes/math.log(2):.4f} tokens={ntok}", flush=True)
