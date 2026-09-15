import sys, time, collections
from datasets import load_dataset
def probe(name, kw, n=1, show=None):
    t=time.time()
    try:
        ds = load_dataset(name, streaming=True, **kw)
        it = iter(ds)
        row = next(it)
        keys = list(row.keys())
        print(f"OK   {name} {kw.get('name') or kw.get('data_dir') or kw.get('data_files') or ''} keys={keys[:10]} ({time.time()-t:.1f}s)")
        if show:
            print("     sample:", repr(row[show])[:200])
        return ds
    except Exception as e:
        print(f"FAIL {name}: {type(e).__name__}: {str(e)[:200]}")
    sys.stdout.flush()
ds = probe("parquet", dict(data_files="hf://datasets/codeparrot/github-code-clean/data/train-00000-of-00880.parquet", split="train"), show="code")
if ds:
    c = collections.Counter()
    for i, r in zip(range(3000), ds): c[r["language"]] += 1
    print("     langs in first 3000:", c.most_common())
probe("substratusai/the-stack-yaml-k8s", dict(split="train"), show="content")
probe("glaiveai/glaive-function-calling-v2", dict(split="train"), show="chat")
probe("NousResearch/hermes-function-calling-v1", dict(name="func_calling", split="train"))
probe("dataunitylab/json-schema", dict(split="train"))
probe("ChristianAzinn/json-training", dict(split="train"))
probe("Salesforce/xlam-function-calling-60k", dict(split="train"))
probe("HuggingFaceTB/stack-edu", dict(name="Markdown", split="train"))
probe("Nan-Do/SPP_30K_reasoning_tasks", dict(split="train"))
