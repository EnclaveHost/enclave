import sys, itertools, time
from datasets import load_dataset
C = [
 ("HuggingFaceFW/fineweb", dict(name="sample-10BT", split="train")),
 ("HuggingFaceFW/fineweb-edu", dict(name="sample-10BT", split="train")),
 ("HuggingFaceH4/ultrachat_200k", dict(split="train_sft")),
 ("HuggingFaceTB/smoltalk", dict(name="all", split="train")),
 ("OpenAssistant/oasst2", dict(split="train")),
 ("allenai/tulu-3-sft-mixture", dict(split="train")),
 ("bigcode/the-stack-smol", dict(data_dir="data/python", split="train")),
 ("bigcode/the-stack-smol", dict(data_dir="data/yaml", split="train")),
 ("bigcode/starcoderdata", dict(data_dir="python", split="train")),
 ("codeparrot/github-code-clean", dict(split="train")),
 ("bigcode/the-stack-dedup", dict(data_dir="data/rust", split="train")),
 ("bigcode/the-stack-v2-dedup", dict(name="Rust", split="train")),
 ("nampdn-ai/tiny-codes", dict(split="train")),
 ("ise-uiuc/Magicoder-Evol-Instruct-110K", dict(split="train")),
 ("HuggingFaceTB/smollm-corpus", dict(name="python-edu", split="train")),
 ("HuggingFaceFW/fineweb-2", dict(name="eng_Latn", split="train")),
 ("sentence-transformers/stackexchange-duplicates", dict(name="title-body-pair", split="train")),
 ("HuggingFaceH4/stack-exchange-preferences", dict(split="train")),
 ("codeparrot/github-jupyter-code-to-text", dict(split="train")),
 ("mlfoundations/dclm-baseline-1.0-parquet", dict(split="train")),
]
for name, kw in C:
    t=time.time()
    try:
        ds = load_dataset(name, streaming=True, **kw)
        row = next(iter(ds))
        keys = list(row.keys())
        print(f"OK   {name} {kw.get('name') or kw.get('data_dir') or ''} keys={keys[:8]} ({time.time()-t:.1f}s)")
    except Exception as e:
        print(f"FAIL {name} {kw.get('name') or kw.get('data_dir') or ''}: {type(e).__name__}: {str(e)[:160]}")
    sys.stdout.flush()
