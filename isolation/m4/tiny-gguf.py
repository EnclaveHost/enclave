#!/usr/bin/env python3
"""tiny-gguf.py <out.gguf> [--vocab N] [--seed S]: a REAL, tiny GGUF language model, standard library only.

What the runtime probe (probe-nn-ggml.sh) and the model-volume tests preload: one qwen2 block, 64 wide, seeded random
f16 weights, the output embedding tied to the input one. The tokenizer is GPT-2 byte-level BPE with an empty merge
list: the 256 byte tokens (so llama.cpp's vocab setup, which tokenizes a newline, finds them), then filler tokens up
to --vocab (default 512; the tests use Qwen2's 151936 so enclave-apps/ggml-probe's prompt ids are in range), with the
last id as BOS/EOS. The weights mean nothing; what this proves is that a graph is STAGED, PRELOADED under its volume
name and SERVED by load_by_name. GGUF v3, written field by field (ggml/docs/gguf.md)."""
import random
import struct
import sys

args = sys.argv[1:]
out = args[0]
vocab_n = int(args[args.index("--vocab") + 1]) if "--vocab" in args else 512
seed = int(args[args.index("--seed") + 1]) if "--seed" in args else 7
if vocab_n < 260:
    sys.exit("--vocab must hold the 256 byte tokens and a few more")

U32, I32, F32, STR, ARR, U64 = 4, 5, 6, 8, 9, 10
ALIGN = 32


def gstr(s):
    b = s.encode()
    return struct.pack("<Q", len(b)) + b


def kv(key, typ, value):
    body = gstr(key) + struct.pack("<I", typ)
    if typ == STR:
        body += gstr(value)
    elif typ == U32:
        body += struct.pack("<I", value)
    elif typ == F32:
        body += struct.pack("<f", value)
    elif typ == ARR:
        et, items = value
        body += struct.pack("<IQ", et, len(items))
        for it in items:
            body += gstr(it) if et == STR else struct.pack("<i", it)
    return body


def bytes_to_unicode():   # GPT-2's reversible byte -> printable character map
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs, n = bs[:], 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return {b: chr(c) for b, c in zip(bs, cs)}


m = bytes_to_unicode()
tokens = [m[b] for b in range(256)] + [f"<|fixture{i}|>" for i in range(256, vocab_n - 1)] + ["<|endoftext|>"]
types = [1] * (vocab_n - 1) + [3]
n_embd, n_ff, n_head = 64, 128, 2
meta = [
    kv("general.architecture", STR, "qwen2"), kv("general.name", STR, "enclave tiny qwen2 fixture"),
    kv("general.alignment", U32, ALIGN), kv("general.file_type", U32, 1),
    kv("qwen2.block_count", U32, 1), kv("qwen2.context_length", U32, 512), kv("qwen2.embedding_length", U32, n_embd),
    kv("qwen2.feed_forward_length", U32, n_ff), kv("qwen2.attention.head_count", U32, n_head),
    kv("qwen2.attention.head_count_kv", U32, n_head), kv("qwen2.rope.freq_base", F32, 1000000.0),
    kv("qwen2.attention.layer_norm_rms_epsilon", F32, 1e-6),
    kv("tokenizer.ggml.model", STR, "gpt2"), kv("tokenizer.ggml.pre", STR, "qwen2"),
    kv("tokenizer.ggml.tokens", ARR, (STR, tokens)), kv("tokenizer.ggml.token_type", ARR, (I32, types)),
    kv("tokenizer.ggml.merges", ARR, (STR, [])),
    kv("tokenizer.ggml.bos_token_id", U32, vocab_n - 1), kv("tokenizer.ggml.eos_token_id", U32, vocab_n - 1),
    kv("tokenizer.ggml.padding_token_id", U32, vocab_n - 1),
]

rng = random.Random(seed)
F32T, F16T = 0, 1


def f16(n):
    return struct.pack(f"<{n}e", *(rng.gauss(0, 0.02) for _ in range(n)))


def f32(n, value=None):
    return struct.pack(f"<{n}f", *((value if value is not None else rng.gauss(0, 0.02)) for _ in range(n)))


# (name, ggml ne (innermost first), type, bytes)
tensors = [("token_embd.weight", (n_embd, vocab_n), F16T, f16(n_embd * vocab_n)),
           ("output_norm.weight", (n_embd,), F32T, f32(n_embd, 1.0)),
           ("blk.0.attn_norm.weight", (n_embd,), F32T, f32(n_embd, 1.0))]
for t in ("q", "k", "v"):
    tensors += [(f"blk.0.attn_{t}.weight", (n_embd, n_embd), F16T, f16(n_embd * n_embd)),
                (f"blk.0.attn_{t}.bias", (n_embd,), F32T, f32(n_embd))]
tensors += [("blk.0.attn_output.weight", (n_embd, n_embd), F16T, f16(n_embd * n_embd)),
            ("blk.0.ffn_norm.weight", (n_embd,), F32T, f32(n_embd, 1.0)),
            ("blk.0.ffn_gate.weight", (n_embd, n_ff), F16T, f16(n_embd * n_ff)),
            ("blk.0.ffn_up.weight", (n_embd, n_ff), F16T, f16(n_embd * n_ff)),
            ("blk.0.ffn_down.weight", (n_ff, n_embd), F16T, f16(n_ff * n_embd))]

pad = lambda n: (ALIGN - n % ALIGN) % ALIGN  # noqa: E731
infos, data, off = b"", b"", 0
for name, ne, typ, raw in tensors:
    infos += gstr(name) + struct.pack("<I", len(ne)) + b"".join(struct.pack("<Q", d) for d in ne) + struct.pack("<IQ", typ, off)
    data += raw + b"\0" * pad(len(raw))
    off += len(raw) + pad(len(raw))
head = b"GGUF" + struct.pack("<IQQ", 3, len(tensors), len(meta)) + b"".join(meta) + infos
with open(out, "wb") as f:
    f.write(head + b"\0" * pad(len(head)) + data)
print(out, len(head) + pad(len(head)) + len(data), "bytes,", vocab_n, "tokens")
