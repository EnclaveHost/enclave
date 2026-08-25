#!/usr/bin/env python3
"""
tokenizer.py -- byte-level BPE, TEE-side.

The tokenizer runs INSIDE the CVM and always will: it consumes the prompt, which
is the secret. It is here rather than pulled from a library because the pack is
meant to be self-contained and because llama.cpp's tokenizer is C++ behind an FFI
we do not want on this path.

Byte-level BPE, GPT-2 lineage, with qwen2's pre-tokenizer split. Correctness here
is load-bearing in an unusual way: a tokenizer that is merely CLOSE produces
plausible text and a silently different token stream, which would make the
equivalence test between the shielded and in-TEE runs pass while both diverged
from llama.cpp. The e2e harness therefore cross-checks token ids against
llama.cpp's own tokenizer rather than trusting this file.
"""

import functools

import regex as re

# qwen2's pre-tokenizer pattern, as carried in the GGUF and used by llama.cpp.
QWEN2_PAT = (r"(?i:'s|'t|'re|'ve|'m|'ll|'d)"
             r"|[^\r\n\p{L}\p{N}]?\p{L}+"
             r"|\p{N}"
             r"| ?[^\s\p{L}\p{N}]+[\r\n]*"
             r"|\s*[\r\n]+"
             r"|\s+(?!\S)"
             r"|\s+")


@functools.lru_cache(maxsize=1)
def _byte_maps():
    """GPT-2's printable-codepoint escape for raw bytes, and its inverse."""
    bs = list(range(ord("!"), ord("~") + 1)) + \
         list(range(ord("\xa1"), ord("\xac") + 1)) + \
         list(range(ord("\xae"), ord("\xff") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    enc = {b: chr(c) for b, c in zip(bs, cs)}
    return enc, {v: k for k, v in enc.items()}


class BPETokenizer:
    def __init__(self, tokens, merges, types=None):
        self.tokens = tokens
        self.vocab = {t: i for i, t in enumerate(tokens)}
        self.ranks = {tuple(m.split(" ")): i for i, m in enumerate(merges)}
        self.pat = re.compile(QWEN2_PAT)
        self.b2u, self.u2b = _byte_maps()
        # Added/control tokens (type 3 = CONTROL in GGUF) are matched literally
        # before any BPE runs, which is how <|im_start|> survives a byte-level
        # tokenizer that would otherwise shred it into punctuation.
        self.special = {}
        if types:
            for i, ty in enumerate(types):
                if ty in (3, 4) and i < len(tokens):
                    self.special[tokens[i]] = i
        self._special_re = re.compile(
            "(" + "|".join(re.escape(s) for s in sorted(self.special, key=len, reverse=True)) + ")"
        ) if self.special else None

    def _bpe(self, word):
        syms = list(word)
        if len(syms) < 2:
            return syms
        while True:
            best, bi = None, None
            for i in range(len(syms) - 1):
                r = self.ranks.get((syms[i], syms[i + 1]))
                if r is not None and (best is None or r < best):
                    best, bi = r, i
            if bi is None:
                return syms
            syms[bi:bi + 2] = [syms[bi] + syms[bi + 1]]
            if len(syms) == 1:
                return syms

    def encode(self, text, allow_special=True):
        out = []
        parts = (self._special_re.split(text)
                 if (allow_special and self._special_re) else [text])
        for part in parts:
            if not part:
                continue
            if allow_special and part in self.special:
                out.append(self.special[part])
                continue
            for chunk in self.pat.findall(part):
                word = "".join(self.b2u[b] for b in chunk.encode("utf-8"))
                for sym in self._bpe(word):
                    idx = self.vocab.get(sym)
                    if idx is None:
                        # Never silently drop: an unknown symbol means the merge
                        # table and the vocab disagree, which is a corrupt pack.
                        raise KeyError(f"BPE produced {sym!r}, absent from the vocab")
                    out.append(idx)
        return out

    def decode(self, ids):
        buf = bytearray()
        for i in ids:
            t = self.tokens[i]
            if t in self.special:
                buf.extend(t.encode("utf-8"))
                continue
            buf.extend(bytes(self.u2b[c] for c in t if c in self.u2b))
        return buf.decode("utf-8", "replace")
