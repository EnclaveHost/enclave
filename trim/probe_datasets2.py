import sys, time
from datasets import load_dataset
from huggingface_hub import HfApi
api = HfApi()
try:
    fs = [f for f in api.list_repo_files("codeparrot/github-code-clean", repo_type="dataset") if f.endswith(".parquet")]
    print("github-code-clean parquet files:", len(fs), fs[:2])
except Exception as e: print("list fail", e)
C = [
 ("parquet", dict(data_files="hf://datasets/codeparrot/github-code-clean/data/train-00000-of-01126.parquet", split="train")),
 ("ise-uiuc/Magicoder-OSS-Instruct-75K", dict(split="train")),
 ("glaiveai/glaive-code-assistant-v3", dict(split="train")),
 ("substratusai/the-stack-yaml-k8s", dict(split="train")),
 ("ammarnasr/the-stack-rust-clean", dict(split="train")),
 ("ammarnasr/the-stack-go-clean", dict(split="train")),
 ("code-search-net/code_search_net", dict(name="go", split="train")),
 ("deepmind/code_contests", dict(split="train")),
 ("bigcode/self-oss-instruct-sc2-exec-filter-50k", dict(split="train")),
 ("nvidia/OpenCodeReasoning", dict(name="split_0", split="split_0")),
 ("codeparrot/codeparrot-clean", dict(split="train")),
 ("bigcode/the-stack-smol-xl", dict(data_dir="data/json", split="train")),
 ("bigcode/the-stack-github-issues", dict(split="train")),
 ("bigcode/commitpackft", dict(data_dir="data/shell", split="train")),
 ("HuggingFaceTB/stack-edu", dict(name="Rust", split="train")),
 ("HuggingFaceTB/stack-edu", dict(name="JSON", split="train")),
 ("HuggingFaceTB/stack-edu", dict(name="Shell", split="train")),
 ("HuggingFaceTB/smollm-corpus", dict(name="cosmopedia-v2", split="train")),
 ("open-web-math/open-web-math", dict(split="train")),
 ("HuggingFaceTB/finemath", dict(name="finemath-3plus", split="train")),
 ("Muennighoff/natural-instructions", dict(split="train")),
 ("cakiki/stack-smol-xxl", dict(split="train")),
 ("thewall/...", dict()),
]
for name, kw in C:
    t=time.time()
    try:
        ds = load_dataset(name, streaming=True, **kw)
        row = next(iter(ds))
        keys = list(row.keys())
        print(f"OK   {name} {kw.get('name') or kw.get('data_dir') or ''} keys={keys[:9]} ({time.time()-t:.1f}s)")
    except Exception as e:
        print(f"FAIL {name} {kw.get('name') or kw.get('data_dir') or ''}: {type(e).__name__}: {str(e)[:200]}")
    sys.stdout.flush()
