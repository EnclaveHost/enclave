"""Tokenize corpus/*.jsonl with the ORIGINAL tokenizer.json and count token frequency.
Writes artifacts/token_freq_{total,english,code}.npy and artifacts/token_frequency.tsv
"""
import sys, os, json, glob, time, numpy as np
from multiprocessing import Pool
HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = glob.glob(os.path.expanduser("~/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/*/"))[0]
V = 262144
MAXCHARS = 1_000_000
import regex
NONLAT = regex.compile(r"[^\p{Latin}\p{Common}\p{Inherited}]")
NONLAT_MAX = 0.02   # document-level English/code filter: drop docs with >2% non-Latin-script characters
_tok = None
def init():
    global _tok
    from tokenizers import Tokenizer
    _tok = Tokenizer.from_file(os.path.join(SNAP, "tokenizer.json"))
def work(job):
    kind, texts = job
    texts = [t[:MAXCHARS] for t in texts]
    kept = [t for t in texts if len(NONLAT.findall(t)) <= NONLAT_MAX * len(t)]
    dropped = len(texts) - len(kept); texts = kept
    enc = _tok.encode_batch(texts, add_special_tokens=False)
    ids = np.concatenate([np.asarray(e.ids, dtype=np.int64) for e in enc]) if enc else np.zeros(0, np.int64)
    return kind, np.bincount(ids, minlength=V), len(ids), sum(len(t.encode("utf-8")) for t in texts), dropped, len(kept)
def jobs():
    for f in sorted(glob.glob(os.path.join(HERE, "corpus", "*.jsonl"))):
        buf, kind, size = [], None, 0
        with open(f) as fh:
            for line in fh:
                r = json.loads(line); kind = r["kind"]
                buf.append(r["text"]); size += len(r["text"])
                if size >= 4_000_000:
                    yield kind, buf; buf, size = [], 0
        if buf: yield kind, buf
if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "artifacts"), exist_ok=True)
    counts = {"english": np.zeros(V, np.int64), "code": np.zeros(V, np.int64)}
    ntok = {"english": 0, "code": 0}; nbytes = {"english": 0, "code": 0}
    t0 = time.time(); n = 0
    with Pool(int(sys.argv[1]) if len(sys.argv) > 1 else 24, initializer=init) as pool:
        ndrop = {"english": 0, "code": 0}; nkeep = {"english": 0, "code": 0}
        for kind, c, nt, nb, dr, kp in pool.imap_unordered(work, jobs(), chunksize=1):
            counts[kind] += c; ntok[kind] += nt; nbytes[kind] += nb; n += 1; ndrop[kind] += dr; nkeep[kind] += kp
            if n % 50 == 0: print(f"chunks={n} tokens={sum(ntok.values())/1e6:.1f}M bytes={sum(nbytes.values())/1e6:.0f}MB {time.time()-t0:.0f}s", flush=True)
    total = counts["english"] + counts["code"]
    np.save(os.path.join(HERE, "artifacts", "token_freq_total.npy"), total)
    np.save(os.path.join(HERE, "artifacts", "token_freq_english.npy"), counts["english"])
    np.save(os.path.join(HERE, "artifacts", "token_freq_code.npy"), counts["code"])
    vocab = json.load(open(os.path.join(SNAP, "tokenizer.json")))["model"]["vocab"]
    inv = {i: p for p, i in vocab.items()}
    with open(os.path.join(HERE, "artifacts", "token_frequency.tsv"), "w") as fh:
        fh.write("id\tpiece\ttotal\tenglish\tcode\n")
        for i in range(V):
            fh.write(f"{i}\t{json.dumps(inv[i], ensure_ascii=False)}\t{total[i]}\t{counts['english'][i]}\t{counts['code'][i]}\n")
    summary = {"tokens": ntok, "bytes": nbytes, "docs_kept": nkeep, "docs_dropped_nonlatin_gt2pct": ndrop, "seconds": time.time() - t0,
               "distinct_tokens_seen": int((total > 0).sum()), "tokens_ge5": int((total >= 5).sum())}
    json.dump(summary, open(os.path.join(HERE, "artifacts", "count_summary.json"), "w"), indent=1)
    print(json.dumps(summary, indent=1))
