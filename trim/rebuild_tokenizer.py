"""Write the trimmed tokenizer (tokenizer.json + tokenizer_config.json + chat_template.jinja) into OUT."""
import os, glob, json, shutil, sys, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = glob.glob(os.path.expanduser("~/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/*/"))[0]
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "gemma-4-E2B-it-en-code")
os.makedirs(OUT, exist_ok=True)
tj = json.load(open(os.path.join(SNAP, "tokenizer.json")))
vocab = tj["model"]["vocab"]; inv = {i: p for p, i in vocab.items()}
keep_ids = np.load(os.path.join(HERE, "artifacts", "keep_ids.npy"))
id_map = {int(o): n for n, o in enumerate(keep_ids)}
new_vocab = {inv[int(o)]: n for o, n in zip(keep_ids, range(len(keep_ids)))}
kept_pieces = set(new_vocab)
new_merges = [[a, b] for a, b in tj["model"]["merges"] if a in kept_pieces and b in kept_pieces and (a + b) in kept_pieces]
tj["model"]["vocab"] = new_vocab; tj["model"]["merges"] = new_merges
for a in tj["added_tokens"]:
    assert a["id"] in id_map, a
    a["id"] = id_map[a["id"]]
tj["added_tokens"].sort(key=lambda a: a["id"])
json.dump(tj, open(os.path.join(OUT, "tokenizer.json"), "w"), ensure_ascii=False, indent=1)
shutil.copy(os.path.join(SNAP, "tokenizer_config.json"), OUT)   # string-based; no ids inside
shutil.copy(os.path.join(SNAP, "chat_template.jinja"), OUT)     # string-based markers; unchanged
print(f"vocab {len(vocab)} -> {len(new_vocab)}; merges {len(tj['model']['merges'])}; added_tokens {len(tj['added_tokens'])}")
# sanity: every special token string resolves to a single id
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained(OUT)
tc = json.load(open(os.path.join(OUT, "tokenizer_config.json")))
for k, v in tc.items():
    if k.endswith("_token") and isinstance(v, str):
        ids = tok.encode(v, add_special_tokens=False); assert len(ids) == 1, (k, v, ids); print(f"  {k:14s} {v!r:20s} -> {ids[0]}")
print("bos/eos/pad/unk:", tok.bos_token_id, tok.eos_token_id, tok.pad_token_id, tok.unk_token_id, "len", len(tok))
