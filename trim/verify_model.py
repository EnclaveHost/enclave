"""GPU checks: logits equality over the kept vocab, greedy generation agreement, held-out perplexity.
Run with CUDA_VISIBLE_DEVICES=1,2 (the two V100s): original on cuda:0, trimmed on cuda:1."""
import os, sys, glob, json, math, random, time, difflib, numpy as np, torch
from transformers import AutoTokenizer, Gemma4ForConditionalGeneration
HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = glob.glob(os.path.expanduser("~/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/*/"))[0]
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "gemma-4-E2B-it-en-code")
DTYPE = {"fp16": torch.float16, "fp32": torch.float32}[os.environ.get("DTYPE", "fp16")]
ATTN = os.environ.get("ATTN", "eager")
id_map = {int(k): v for k, v in json.load(open(os.path.join(HERE, "artifacts", "id_map_old_to_new.json"))).items()}
keep = torch.tensor(sorted(id_map), dtype=torch.long)
to, tt = AutoTokenizer.from_pretrained(SNAP), AutoTokenizer.from_pretrained(OUT)
t0 = time.time()
mo = Gemma4ForConditionalGeneration.from_pretrained(SNAP, dtype=DTYPE, device_map={"": 0}, attn_implementation=ATTN).eval()
mt = Gemma4ForConditionalGeneration.from_pretrained(OUT, dtype=DTYPE, device_map={"": 1}, attn_implementation=ATTN).eval()
print(f"models loaded ({DTYPE}, {ATTN}) in {time.time()-t0:.0f}s; trimmed vocab {mt.config.text_config.vocab_size}", flush=True)
BOS_O, BOS_T = to.bos_token_id, tt.bos_token_id
def heldout(kind):
    docs = []
    for f in sorted(glob.glob(os.path.join(HERE, "corpus", "heldout", "*.jsonl"))):
        for line in open(f):
            r = json.loads(line)
            if r["kind"] == kind: docs.append(r["text"])
    random.Random(0).shuffle(docs); return docs
res = {}
# ---- 1. logits over kept vocab, same token sequence fed to both models
MAXLEN = 384
stats = {"english": [], "code": []}; hid = []; skipped = 0
for kind in stats:
    docs = heldout(kind); used = 0
    for d in docs:
        ids = to.encode(d[:6000], add_special_tokens=False)[:MAXLEN]
        if any(i not in id_map for i in ids): skipped += 1; continue
        xo = torch.tensor([[BOS_O] + ids], device="cuda:0"); xt = torch.tensor([[BOS_T] + [id_map[i] for i in ids]], device="cuda:1")
        with torch.no_grad():
            oo = mo(input_ids=xo, output_hidden_states=True); ot = mt(input_ids=xt, output_hidden_states=True)
        lo = oo.logits[0].float().cpu()[:, keep]; lt = ot.logits[0].float().cpu()
        d_log = (lo - lt).abs().max().item()
        ho, ht = oo.hidden_states[-1][0].float().cpu(), ot.hidden_states[-1][0].float().cpu()
        d_hid = (ho - ht).abs().max().item()
        # fp32 head from identical hidden states (isolates GEMM-shape rounding from row-mapping errors)
        w = mo.model.language_model.embed_tokens.weight[keep].float()
        l32o = torch.tanh((oo.hidden_states[-1][0].float() @ w.T) / 30) * 30
        w2 = mt.model.language_model.embed_tokens.weight.float()
        l32t = torch.tanh((ot.hidden_states[-1][0].float() @ w2.T) / 30) * 30
        d_32 = (l32o.cpu() - l32t.cpu()).abs().max().item()
        argmax_same = (lo.argmax(-1) == lt.argmax(-1)).float().mean().item()
        stats[kind].append((d_log, d_hid, d_32, argmax_same, len(ids) + 1)); used += 1
        if used >= 200: break
    a = np.array(stats[kind])
    res[f"logits_{kind}"] = {"prompts": int(len(a)), "positions": int(a[:, 4].sum()), "max_abs_diff_fp16_logits": float(a[:, 0].max()),
                            "max_abs_diff_last_hidden": float(a[:, 1].max()), "max_abs_diff_fp32_head": float(a[:, 2].max()),
                            "argmax_agreement": float(a[:, 3].mean()), "prompts_under_1e-3": int((a[:, 0] < 1e-3).sum())}
    print(kind, res[f"logits_{kind}"], flush=True)
res["logits_skipped_prompts_with_dropped_tokens"] = skipped
# ---- 2. greedy generation, thinking disabled
prompts = ["Explain what a hash map is.", "Write a Python function to check if a number is prime.", "What is the capital of Australia?",
           "Write a bash one-liner to count lines in all .py files.", "Summarize the plot of Romeo and Juliet in two sentences.",
           "Write a Rust function that sums a slice of i32.", "How do I center a div in CSS?", "Give me a JSON object describing a book.",
           "What does the 'static' keyword do in C?", "Write a haiku about autumn."]
docs_e, docs_c = heldout("english"), heldout("code")
for i in range(40):
    src = docs_e if i % 2 == 0 else docs_c
    prompts.append(("Continue this text:\n\n" if i % 2 == 0 else "Explain this code:\n\n") + src[i][:600])
gen = []; identical = 0
for p in prompts[:50]:
    msgs = [{"role": "user", "content": p}]
    xo = to.apply_chat_template(msgs, add_generation_prompt=True, enable_thinking=False, return_tensors="pt", return_dict=True).to("cuda:0")
    xt = tt.apply_chat_template(msgs, add_generation_prompt=True, enable_thinking=False, return_tensors="pt", return_dict=True).to("cuda:1")
    with torch.no_grad():
        go = mo.generate(**xo, max_new_tokens=64, do_sample=False); gt = mt.generate(**xt, max_new_tokens=64, do_sample=False)
    so = to.decode(go[0, xo["input_ids"].shape[1]:], skip_special_tokens=True); st = tt.decode(gt[0, xt["input_ids"].shape[1]:], skip_special_tokens=True)
    same = so == st; identical += same
    gen.append({"prompt": p[:80], "identical": same, "original": so, "trimmed": st})
    if not same: print("GEN DIFF:", repr(p[:60])); print("\n".join(difflib.unified_diff(so.splitlines(), st.splitlines(), "original", "trimmed", lineterm="")))
res["greedy_identical"] = identical; res["greedy_total"] = len(gen)
print(f"greedy identical: {identical}/{len(gen)}", flush=True)
json.dump(gen, open(os.path.join(HERE, "artifacts", "greedy_outputs.json"), "w"), indent=1)
# ---- 3. perplexity on held-out (each model with its own tokenizer)
def ppl(model, tok, bos, docs, dev, n=120, maxlen=1024):
    nll = ntok = nbytes = 0
    for d in docs[:n]:
        ids = tok.encode(d[:8000], add_special_tokens=False)[:maxlen]
        x = torch.tensor([[bos] + ids], device=dev)
        with torch.no_grad(): logits = model(input_ids=x).logits[0, :-1].float()
        nll += torch.nn.functional.cross_entropy(logits, x[0, 1:], reduction="sum").item()
        ntok += len(ids); nbytes += len(tok.decode(ids).encode("utf-8"))
    return {"token_ppl": math.exp(nll / ntok), "bits_per_byte": nll / nbytes / math.log(2), "tokens": ntok, "bytes": nbytes}
for kind, docs in (("english", docs_e), ("code", docs_c)):
    res[f"ppl_{kind}_original"] = ppl(mo, to, BOS_O, docs, "cuda:0"); res[f"ppl_{kind}_trimmed"] = ppl(mt, tt, BOS_T, docs, "cuda:1")
    print(kind, "orig", res[f"ppl_{kind}_original"], "trim", res[f"ppl_{kind}_trimmed"], flush=True)
json.dump(res, open(os.path.join(HERE, "artifacts", "verify_model.json"), "w"), indent=1)
print(json.dumps(res, indent=1))
