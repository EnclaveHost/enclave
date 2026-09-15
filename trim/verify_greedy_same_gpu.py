"""Greedy generation (thinking disabled) with BOTH models on the same GPU, fp16, so kernel choice is identical."""
import os, sys, glob, json, random, difflib, torch
from transformers import AutoTokenizer, Gemma4ForConditionalGeneration
HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = glob.glob(os.path.expanduser("~/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/*/"))[0]
OUT = os.path.join(HERE, "..", "gemma-4-E2B-it-en-code")
to, tt = AutoTokenizer.from_pretrained(SNAP), AutoTokenizer.from_pretrained(OUT)
mo = Gemma4ForConditionalGeneration.from_pretrained(SNAP, dtype=torch.float16, device_map={"": 0}, attn_implementation="eager").eval()
mt = Gemma4ForConditionalGeneration.from_pretrained(OUT, dtype=torch.float16, device_map={"": 0}, attn_implementation="eager").eval()
prompts = [g["prompt"] for g in json.load(open(os.path.join(HERE, "artifacts", "greedy_outputs.json")))]
# the stored prompts were truncated to 80 chars for the log; rebuild the same list
prompts = ["Explain what a hash map is.", "Write a Python function to check if a number is prime.", "What is the capital of Australia?",
           "Write a bash one-liner to count lines in all .py files.", "Summarize the plot of Romeo and Juliet in two sentences.",
           "Write a Rust function that sums a slice of i32.", "How do I center a div in CSS?", "Give me a JSON object describing a book.",
           "What does the 'static' keyword do in C?", "Write a haiku about autumn."]
docs = {"english": [], "code": []}
for f in sorted(glob.glob(os.path.join(HERE, "corpus", "heldout", "*.jsonl"))):
    for line in open(f):
        r = json.loads(line); docs[r["kind"]].append(r["text"])
for k in docs: random.Random(0).shuffle(docs[k])
for i in range(40):
    src = docs["english"] if i % 2 == 0 else docs["code"]
    prompts.append(("Continue this text:\n\n" if i % 2 == 0 else "Explain this code:\n\n") + src[i][:600])
gen = []; identical = 0; max_new = int(os.environ.get("MAX_NEW", "64"))
for p in prompts[:50]:
    msgs = [{"role": "user", "content": p}]
    xo = to.apply_chat_template(msgs, add_generation_prompt=True, enable_thinking=False, return_tensors="pt", return_dict=True).to("cuda:0")
    xt = tt.apply_chat_template(msgs, add_generation_prompt=True, enable_thinking=False, return_tensors="pt", return_dict=True).to("cuda:0")
    with torch.no_grad():
        go = mo.generate(**xo, max_new_tokens=max_new, do_sample=False); gt = mt.generate(**xt, max_new_tokens=max_new, do_sample=False)
    so = to.decode(go[0, xo["input_ids"].shape[1]:], skip_special_tokens=True); st = tt.decode(gt[0, xt["input_ids"].shape[1]:], skip_special_tokens=True)
    same = so == st; identical += same; gen.append({"prompt": p[:80], "identical": same, "original": so, "trimmed": st})
    if not same: print("GEN DIFF:", repr(p[:60])); print("\n".join(difflib.unified_diff(so.splitlines(), st.splitlines(), "original", "trimmed", lineterm="")))
print(f"same-GPU fp16 greedy identical: {identical}/{len(gen)} (max_new_tokens={max_new})")
json.dump({"identical": identical, "total": len(gen), "max_new_tokens": max_new, "outputs": gen}, open(os.path.join(HERE, "artifacts", "greedy_same_gpu.json"), "w"), indent=1)
