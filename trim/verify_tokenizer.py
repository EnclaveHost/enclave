"""Round-trip + tokenization-equivalence check on 1000 English and 1000 code samples."""
import os, sys, glob, json, random, numpy as np
from tokenizers import Tokenizer
HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = glob.glob(os.path.expanduser("~/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/*/"))[0]
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "gemma-4-E2B-it-en-code")
orig = Tokenizer.from_file(os.path.join(SNAP, "tokenizer.json")); trim = Tokenizer.from_file(os.path.join(OUT, "tokenizer.json"))
id_map = {int(k): v for k, v in json.load(open(os.path.join(HERE, "artifacts", "id_map_old_to_new.json"))).items()}
def samples(kind, n):
    docs = []
    files = [f for f in sorted(glob.glob(os.path.join(HERE, "corpus", "*.jsonl"))) if json.loads(open(f).readline())["kind"] == kind]
    per = n // len(files) + 1
    for f in files:
        lines = open(f).readlines()[-per * 3:]        # tail of each source
        docs += [json.loads(l)["text"][:20000] for l in lines[-per:]]
    random.Random(0).shuffle(docs); return docs[:n]
res = {}
for kind in ("english", "code"):
    docs = samples(kind, 1000)
    rt_trim = rt_orig = same = 0; bad = []
    for d in docs:
        eo = orig.encode(d, add_special_tokens=False).ids; et = trim.encode(d, add_special_tokens=False).ids
        rt_orig += orig.decode(eo, skip_special_tokens=False) == d
        ok = trim.decode(et, skip_special_tokens=False) == d; rt_trim += ok
        mapped = [id_map.get(i, -1) for i in eo]
        if mapped == et: same += 1
        else: bad.append({"dropped_in_orig": any(m == -1 for m in mapped), "text": d[:100]})
        if not ok: print("ROUNDTRIP FAIL", kind, repr(d[:200]))
    res[kind] = {"n": len(docs), "roundtrip_trimmed": rt_trim, "roundtrip_original": rt_orig, "tokenization_identical": same,
                 "differ_with_dropped_token": sum(b["dropped_in_orig"] for b in bad), "differ_without_dropped_token": sum(not b["dropped_in_orig"] for b in bad)}
    print(kind, res[kind])
    for b in bad[:5]: print("   differs:", b)
json.dump(res, open(os.path.join(HERE, "artifacts", "verify_tokenizer.json"), "w"), indent=1)
