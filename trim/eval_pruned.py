"""Quality test of the pruned model on the RTX 3070 (fp16): greedy answers + held-out perplexity on the same docs as verify_model.py."""
import os, glob, json, math, random, sys, torch
from transformers import AutoTokenizer, Gemma4ForConditionalGeneration
HERE = os.path.dirname(os.path.abspath(__file__))
M = sys.argv[1]
tok = AutoTokenizer.from_pretrained(M)
model = Gemma4ForConditionalGeneration.from_pretrained(M, dtype=torch.float16, device_map={"": 0}, attn_implementation="eager").eval()
print("params", sum(p.numel() for p in model.parameters())/1e9, "B; device", next(model.parameters()).device)
prompts = ["Explain what a hash map is.", "Write a Python function to check if a number is prime.", "What is the capital of Australia?",
           "Write a bash one-liner to count lines in all .py files.", "Summarize the plot of Romeo and Juliet in two sentences.", "Write a short joke about saving RAM."]
for p in prompts:
    x = tok.apply_chat_template([{"role": "user", "content": p}], add_generation_prompt=True, enable_thinking=False, return_tensors="pt", return_dict=True).to("cuda:0")
    with torch.no_grad(): g = model.generate(**x, max_new_tokens=80, do_sample=False)
    print(f"\n### {p}\n{tok.decode(g[0, x['input_ids'].shape[1]:], skip_special_tokens=True)}")
docs = {"english": [], "code": []}
for f in sorted(glob.glob(os.path.join(HERE, "corpus", "heldout", "*.jsonl"))):
    for line in open(f):
        r = json.loads(line); docs[r["kind"]].append(r["text"])
for k in docs: random.Random(0).shuffle(docs[k])
for kind in docs:
    nll = ntok = nbytes = 0
    for d in docs[kind][:120]:
        ids = tok.encode(d[:8000], add_special_tokens=False)[:1024]
        x = torch.tensor([[tok.bos_token_id] + ids], device="cuda:0")
        with torch.no_grad(): logits = model(input_ids=x).logits[0, :-1].float()
        nll += torch.nn.functional.cross_entropy(logits, x[0, 1:], reduction="sum").item(); ntok += len(ids); nbytes += len(tok.decode(ids).encode("utf-8"))
    print(f"\nPPL {kind}: token_ppl={math.exp(nll/ntok):.3f} bits_per_byte={nll/nbytes/math.log(2):.4f} tokens={ntok}")
