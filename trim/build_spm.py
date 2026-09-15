"""Best-effort SentencePiece BPE export (tokenizer.model) of the trimmed tokenizer.json.
Gemma 4 ships no tokenizer.model, so this is reconstructed: piece scores are derived from merge rank
(sentencepiece BPE merges the adjacent pair whose concatenation has the highest score).
It is only written if it reproduces the tokenizers-BPE output on the sample texts."""
import os, sys, json, glob, re, random
import sentencepiece as spm
from sentencepiece import sentencepiece_model_pb2 as pb
from tokenizers import Tokenizer
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "gemma-4-E2B-it-en-code")
tj = json.load(open(os.path.join(OUT, "tokenizer.json")))
vocab = tj["model"]["vocab"]; inv = {i: p for p, i in vocab.items()}; merges = tj["model"]["merges"]
added = {a["content"] for a in tj["added_tokens"]}
# merge rank -> score: first merge producing a piece defines its score (higher = earlier)
score = {}
for r, (a, b) in enumerate(merges):
    score.setdefault(a + b, -float(r + 1))
m = pb.ModelProto()
for i in range(len(inv)):
    p = inv[i]; sp = m.pieces.add(); sp.piece = p
    if p == "<unk>": sp.type = pb.ModelProto.SentencePiece.UNKNOWN; sp.score = 0.0
    elif p in added or p.startswith("<unused"): sp.type = pb.ModelProto.SentencePiece.CONTROL; sp.score = 0.0
    elif re.fullmatch(r"<0x[0-9A-F]{2}>", p): sp.type = pb.ModelProto.SentencePiece.BYTE; sp.score = 0.0
    else:
        sp.type = pb.ModelProto.SentencePiece.NORMAL
        sp.score = score.get(p, -float(len(merges) + 2))   # single chars: below every merge
m.trainer_spec.model_type = pb.TrainerSpec.BPE
m.trainer_spec.vocab_size = len(inv); m.trainer_spec.byte_fallback = True
m.trainer_spec.unk_id = vocab["<unk>"]; m.trainer_spec.bos_id = vocab["<bos>"]; m.trainer_spec.eos_id = vocab["<eos>"]; m.trainer_spec.pad_id = vocab["<pad>"]
m.trainer_spec.unk_piece = "<unk>"; m.trainer_spec.bos_piece = "<bos>"; m.trainer_spec.eos_piece = "<eos>"; m.trainer_spec.pad_piece = "<pad>"
m.normalizer_spec.name = "identity"; m.normalizer_spec.add_dummy_prefix = False
m.normalizer_spec.remove_extra_whitespaces = False; m.normalizer_spec.escape_whitespaces = True
tmp = os.path.join(HERE, "artifacts", "tokenizer.model.candidate")
open(tmp, "wb").write(m.SerializeToString())
sp = spm.SentencePieceProcessor(model_file=tmp)
hf = Tokenizer.from_file(os.path.join(OUT, "tokenizer.json"))
texts = []
for f in sorted(glob.glob(os.path.join(HERE, "corpus", "heldout", "*.jsonl"))):
    for line in open(f): texts.append(json.loads(line)["text"][:3000])
random.Random(1).shuffle(texts); texts = texts[:1000]
same = sum(1 for t in texts if sp.encode(t) == hf.encode(t, add_special_tokens=False).ids)
print(f"sentencepiece == tokenizers on {same}/{len(texts)} held-out samples")
if same == len(texts):
    os.replace(tmp, os.path.join(OUT, "tokenizer.model")); print("wrote tokenizer.model")
else:
    bad = next(t for t in texts if sp.encode(t) != hf.encode(t, add_special_tokens=False).ids)
    print("MISMATCH example:", repr(bad[:120])); print(" spm:", sp.encode(bad)[:30]); print(" hf :", hf.encode(bad, add_special_tokens=False).ids[:30])
    print("NOT writing tokenizer.model")
