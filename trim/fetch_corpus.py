"""Stream one source from the Hub and write up to BUDGET bytes of text to corpus/<name>.jsonl.
Every 250th document (max 40) goes to corpus/heldout/<name>.jsonl instead (perplexity / round-trip set).
Usage: fetch_corpus.py <source-name>
"""
import sys, json, os, time, random, io, itertools
from datasets import load_dataset
name = sys.argv[1]
MB = 1_000_000
HERE = os.path.dirname(os.path.abspath(__file__))

def msgs(rows, rk="role", ck="content"):
    return "\n\n".join(f"{m[rk]}: {m[ck]}" for m in rows)

CODE_LANG_CAPS = {"Python":160, "JavaScript":110, "TypeScript":90, "Rust":40, "GO":60, "C":90, "Shell":50,
                  "Markdown":90, "Makefile":8, "Dockerfile":5, "CMake":5, "SQL":15, "C++":20, "Java":15,
                  "Batchfile":3, "PowerShell":3}

SOURCES = {
 # english
 "fineweb":      ("english", 400*MB, lambda: load_dataset("HuggingFaceFW/fineweb", name="sample-10BT", split="train", streaming=True), lambda r: r["text"]),
 "fineweb_edu":  ("english", 150*MB, lambda: load_dataset("HuggingFaceFW/fineweb-edu", name="sample-10BT", split="train", streaming=True), lambda r: r["text"]),
 "stackexchange":("english", 150*MB, lambda: load_dataset("HuggingFaceH4/stack-exchange-preferences", split="train", streaming=True),
                  lambda r: r["question"] + "\n\n" + "\n\n".join(a["text"] for a in r["answers"])),
 "ultrachat":    ("english", 150*MB, lambda: load_dataset("HuggingFaceH4/ultrachat_200k", split="train_sft", streaming=True), lambda r: msgs(r["messages"])),
 "smoltalk":     ("english", 100*MB, lambda: load_dataset("HuggingFaceTB/smoltalk", name="all", split="train", streaming=True), lambda r: msgs(r["messages"])),
 "tulu3":        ("english", 80*MB,  lambda: load_dataset("allenai/tulu-3-sft-mixture", split="train", streaming=True), lambda r: msgs(r["messages"])),
 "oasst2":       ("english", 40*MB,  lambda: load_dataset("OpenAssistant/oasst2", split="train", streaming=True), lambda r: r["text"] if r["lang"]=="en" else None),
 "openwebmath":  ("english", 40*MB,  lambda: load_dataset("open-web-math/open-web-math", split="train", streaming=True), lambda r: r["text"]),
 "cosmopedia":   ("english", 50*MB,  lambda: load_dataset("HuggingFaceTB/smollm-corpus", name="cosmopedia-v2", split="train", streaming=True), lambda r: r["text"]),
 # code
 "rust_clean":   ("code", 100*MB, lambda: load_dataset("ammarnasr/the-stack-rust-clean", split="train", streaming=True), lambda r: r["content"]),
 "csn_go":       ("code", 50*MB,  lambda: load_dataset("code-search-net/code_search_net", name="go", split="train", streaming=True), lambda r: r["whole_func_string"]),
 "yaml_k8s":     ("code", 60*MB,  lambda: load_dataset("substratusai/the-stack-yaml-k8s", split="train", streaming=True), lambda r: r["content"]),
 "json_schema":  ("code", 60*MB,  lambda: load_dataset("dataunitylab/json-schema", split="train", streaming=True), lambda r: r["content"]),
 "glaive_fc":    ("code", 30*MB,  lambda: load_dataset("glaiveai/glaive-function-calling-v2", split="train", streaming=True), lambda r: r["system"] + "\n\n" + r["chat"]),
 "hermes_fc":    ("code", 20*MB,  lambda: load_dataset("NousResearch/hermes-function-calling-v1", name="func_calling", split="train", streaming=True),
                  lambda r: json.dumps(r["tools"]) if isinstance(r["tools"], (list, dict)) else str(r["tools"])) ,
 "magicoder_oss":("code", 80*MB,  lambda: load_dataset("ise-uiuc/Magicoder-OSS-Instruct-75K", split="train", streaming=True), lambda r: r["problem"] + "\n\n" + r["solution"]),
 "magicoder_evol":("code", 60*MB, lambda: load_dataset("ise-uiuc/Magicoder-Evol-Instruct-110K", split="train", streaming=True), lambda r: r["instruction"] + "\n\n" + r["response"]),
 "glaive_code":  ("code", 60*MB,  lambda: load_dataset("glaiveai/glaive-code-assistant-v3", split="train", streaming=True), lambda r: r["question"] + "\n\n" + r["answer"]),
 "codeparrot_py":("code", 60*MB,  lambda: load_dataset("codeparrot/codeparrot-clean", split="train", streaming=True), lambda r: r["content"]),
 "jupyter":      ("code", 30*MB,  lambda: load_dataset("codeparrot/github-jupyter-code-to-text", split="train", streaming=True), lambda r: r["content"]),
}

def github_code():
    from huggingface_hub import HfApi
    fs = sorted(f for f in HfApi().list_repo_files("codeparrot/github-code-clean", repo_type="dataset") if f.endswith(".parquet"))
    random.Random(0).shuffle(fs)
    files = ["hf://datasets/codeparrot/github-code-clean/" + f for f in fs[:200]]
    return load_dataset("parquet", data_files=files, split="train", streaming=True)

if name == "github_code":
    kind, budget = "code", sum(CODE_LANG_CAPS.values())*MB
    ds, textf = github_code(), lambda r: r["code"]
    caps = {k: v*MB for k, v in CODE_LANG_CAPS.items()}
    SCAN_LIMIT = 4_500*MB   # stay under the 5 GB pull rule
else:
    kind, budget, mk, textf = SOURCES[name]
    ds, caps, SCAN_LIMIT = mk(), None, None

out = open(os.path.join(HERE, "corpus", f"{name}.jsonl"), "w")
held = open(os.path.join(HERE, "corpus", "heldout", f"{name}.jsonl"), "w")
written = scanned = ndocs = nheld = 0
per_lang = {}
t0 = time.time()
for i, r in enumerate(ds):
    try:
        text = textf(r)
    except Exception as e:
        continue
    if not text or not isinstance(text, str):
        continue
    b = len(text.encode("utf-8"))
    scanned += b
    lang = r.get("language") if caps else None
    if caps:
        if lang not in caps or per_lang.get(lang, 0) >= caps[lang]:
            if scanned > SCAN_LIMIT or all(per_lang.get(k, 0) >= v for k, v in caps.items()):
                break
            continue
        per_lang[lang] = per_lang.get(lang, 0) + b
    rec = json.dumps({"src": name, "kind": kind, "lang": lang, "text": text}, ensure_ascii=False) + "\n"
    if ndocs % 250 == 0 and ndocs > 0 and nheld < 40:
        held.write(rec); nheld += 1
    else:
        out.write(rec); written += b
    ndocs += 1
    if ndocs % 5000 == 0:
        print(f"[{name}] docs={ndocs} written={written/MB:.0f}MB scanned={scanned/MB:.0f}MB {time.time()-t0:.0f}s {per_lang if caps else ''}", flush=True)
    if written >= budget:
        break
out.close(); held.close()
print(f"[{name}] DONE docs={ndocs} heldout={nheld} written={written/MB:.1f}MB scanned={scanned/MB:.0f}MB in {time.time()-t0:.0f}s", {k: round(v/MB) for k, v in per_lang.items()} if caps else "", flush=True)
