"""Build the keep set from the frequency table + rules, close it under BPE merge parents,
and write artifacts/keep_ids.npy, artifacts/id_map_old_to_new.json, artifacts/keepset_summary.json"""
import os, glob, json, re, string, collections, numpy as np
import unicodedataplus as ud
HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = glob.glob(os.path.expanduser("~/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/*/"))[0]
ART = os.path.join(HERE, "artifacts")
MIN_FREQ = 5

tj = json.load(open(os.path.join(SNAP, "tokenizer.json")))
vocab = tj["model"]["vocab"]; inv = {i: p for p, i in vocab.items()}; V = len(vocab)
merges = tj["model"]["merges"]
freq = np.load(os.path.join(ART, "token_freq_total.npy"))
reasons = collections.defaultdict(set)

# 1. frequency floor
for i in np.nonzero(freq >= MIN_FREQ)[0]: reasons[int(i)].add("freq")
# 2. pure printable ASCII (▁ = space; tab/newline/CR count as printable whitespace)
PRINTABLE = set(chr(c) for c in range(0x20, 0x7F)) | {"\t", "\n", "\r", "▁"}
for i, p in inv.items():
    if p and all(c in PRINTABLE for c in p): reasons[i].add("ascii")
# 3. byte fallback tokens
for i, p in inv.items():
    if re.fullmatch(r"<0x[0-9A-F]{2}>", p): reasons[i].add("byte")
# 4. special / control tokens from the files (not hardcoded)
special_strings = set()
for a in tj["added_tokens"]: special_strings.add(a["content"])
tc = json.load(open(os.path.join(SNAP, "tokenizer_config.json")))
for k, v in tc.items():
    if k.endswith("_token") and isinstance(v, str): special_strings.add(v)
    if k == "extra_special_tokens": special_strings.update(v)
for k in ("response_template",):
    for s in re.findall(r"<[^<>\s]*?>", json.dumps(tc.get(k, {}))): special_strings.add(s)
tmpl = open(os.path.join(SNAP, "chat_template.jinja")).read()
for s in re.findall(r"<[|\"a-z_]*?>", tmpl): special_strings.add(s)          # literal <...> markers in the template
special_ids = set()
for s in special_strings:
    if s in vocab: special_ids.add(vocab[s])
    else: print("WARN special string not a single vocab piece:", repr(s))
cfg = json.load(open(os.path.join(SNAP, "config.json"))); gen = json.load(open(os.path.join(SNAP, "generation_config.json")))
def walk(d, path=""):
    if isinstance(d, dict):
        for k, v in d.items():
            if re.search(r"token_(id|index)$", k):
                for x in (v if isinstance(v, list) else [v]):
                    if isinstance(x, int): special_ids.add(x); reasons[x].add(f"config:{path}{k}")
            walk(v, path + k + ".")
walk(cfg); walk(gen)
for f in ("processor_config.json", "preprocessor_config.json"):
    pth = os.path.join(SNAP, f)
    if os.path.exists(pth):
        pc = json.load(open(pth)); walk(pc)
        for s in re.findall(r"<[|\"a-z_]*?>", json.dumps(pc)):
            if s in vocab: special_ids.add(vocab[s]); reasons[vocab[s]].add("processor")
for i in special_ids: reasons[i].add("special")
print("special strings:", sorted(special_strings)); print("special ids:", sorted(special_ids))

before_closure = set(reasons)
# 5. closure under merge parents: any merge that PRODUCES a kept piece keeps both parents (recursively)
producers = collections.defaultdict(list)
for a, b in merges: producers[a + b].append((a, b))
stack = list(before_closure); keep = set(before_closure)
while stack:
    i = stack.pop()
    for a, b in producers.get(inv[i], ()):
        for q in (vocab[a], vocab[b]):
            if q not in keep: keep.add(q); reasons[q].add("merge-parent"); stack.append(q)
print(f"vocab {V}: freq>=5 {int((freq>=5).sum())}, +ascii/byte/special -> {len(before_closure)}, +merge-parent closure -> {len(keep)}")

keep_ids = np.array(sorted(keep), dtype=np.int64)
np.save(os.path.join(ART, "keep_ids.npy"), keep_ids)
id_map = {int(o): n for n, o in enumerate(keep_ids)}
json.dump(id_map, open(os.path.join(ART, "id_map_old_to_new.json"), "w"))
with open(os.path.join(ART, "keep_reasons.tsv"), "w") as fh:
    fh.write("old_id\tnew_id\tpiece\tfreq\treasons\n")
    for o in keep_ids: fh.write(f"{o}\t{id_map[int(o)]}\t{json.dumps(inv[int(o)], ensure_ascii=False)}\t{freq[o]}\t{','.join(sorted(reasons[int(o)]))}\n")

# histogram by Unicode script (▁ ignored; token = its dominant non-Common script, else Common)
def script_of(p):
    if re.fullmatch(r"<0x[0-9A-F]{2}>", p): return "ByteFallback"
    if p in special_strings or p.startswith("<unused"): return "Special/Reserved"
    c = collections.Counter(ud.script(ch) for ch in p.replace("▁", ""))
    for s in ("Common", "Inherited"): c.pop(s, None)
    return c.most_common(1)[0][0] if c else "Common (punct/space/digits/symbols)"
hist = collections.Counter(script_of(inv[int(o)]) for o in keep_ids)
hist_all = collections.Counter(script_of(inv[i]) for i in range(V))
print("\nKept tokens by Unicode script (kept / original):")
for s, n in hist.most_common(): print(f"  {s:40s} {n:7d} / {hist_all[s]}")
unused_kept = sum(1 for o in keep_ids if inv[int(o)].startswith("<unused"))
summary = {"original_vocab": V, "freq_ge5": int((freq>=5).sum()), "before_closure": len(before_closure), "kept": len(keep),
           "added_by_closure": len(keep)-len(before_closure), "unused_reserved_kept": unused_kept,
           "special_ids": sorted(special_ids), "special_strings": sorted(special_strings), "hist": dict(hist.most_common()), "hist_original": dict(hist_all.most_common())}
json.dump(summary, open(os.path.join(ART, "keepset_summary.json"), "w"), indent=1, ensure_ascii=False)
print("unused/reserved <unusedN> tokens kept by the ASCII rule:", unused_kept)
