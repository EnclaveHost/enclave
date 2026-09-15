"""Held-out perplexity with both models on the same GPU (fp16), each with its own tokenizer.
Reports all docs, and separately the docs whose original tokenization uses only kept tokens (like-for-like)."""
import os, glob, json, math, random, torch
from transformers import AutoTokenizer, Gemma4ForConditionalGeneration
HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = glob.glob(os.path.expanduser("~/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/*/"))[0]
OUT = os.path.join(HERE, "..", "gemma-4-E2B-it-en-code")
id_map = {int(k): v for k, v in json.load(open(os.path.join(HERE, "artifacts", "id_map_old_to_new.json"))).items()}
to, tt = AutoTokenizer.from_pretrained(SNAP), AutoTokenizer.from_pretrained(OUT)
mo = Gemma4ForConditionalGeneration.from_pretrained(SNAP, dtype=torch.float16, device_map={"": 0}, attn_implementation="eager").eval()
mt = Gemma4ForConditionalGeneration.from_pretrained(OUT, dtype=torch.float16, device_map={"": 0}, attn_implementation="eager").eval()
docs = {"english": [], "code": []}
for f in sorted(glob.glob(os.path.join(HERE, "corpus", "heldout", "*.jsonl"))):
    for line in open(f):
        r = json.loads(line); docs[r["kind"]].append(r["text"])
for k in docs: random.Random(0).shuffle(docs[k])
def nll(model, tok, ids):
    x = torch.tensor([[tok.bos_token_id] + ids], device="cuda:0")
    with torch.no_grad(): logits = model(input_ids=x).logits[0, :-1].float()
    return torch.nn.functional.cross_entropy(logits, x[0, 1:], reduction="sum").item()
res = {}
for kind in docs:
    acc = {"all": {"o": [0, 0, 0], "t": [0, 0, 0]}, "clean": {"o": [0, 0, 0], "t": [0, 0, 0]}}; nclean = 0
    for d in docs[kind][:120]:
        io = to.encode(d[:8000], add_special_tokens=False)[:1024]; it = tt.encode(d[:8000], add_special_tokens=False)[:1024]
        clean = all(i in id_map for i in io) and [id_map[i] for i in io] == it
        no, nt = nll(mo, to, io), nll(mt, tt, it); b = len(to.decode(io).encode("utf-8"))
        for grp in (["all", "clean"] if clean else ["all"]):
            for key, n, ids in (("o", no, io), ("t", nt, it)):
                acc[grp][key][0] += n; acc[grp][key][1] += len(ids); acc[grp][key][2] += b
        nclean += clean
    out = {"docs": min(120, len(docs[kind])), "docs_clean": nclean}
    for grp in acc:
        for key, name in (("o", "original"), ("t", "trimmed")):
            s, n, b = acc[grp][key]
            out[f"{grp}_{name}"] = {"token_ppl": round(math.exp(s / n), 4), "bits_per_byte": round(s / b / math.log(2), 5), "tokens": n}
    res[kind] = out; print(kind, json.dumps(out, indent=1), flush=True)
json.dump(res, open(os.path.join(HERE, "artifacts", "ppl_same_gpu.json"), "w"), indent=1)
