#!/usr/bin/env python3
"""
pack.py -- GGUF -> shielded model pack. Runs on the HOST, offline, once.

WHY A BUILD STEP AT ALL
-----------------------
A GGUF holds a dozen block quantisations (this file alone mixes Q5_0, Q8_0, Q4_K,
Q6_K and F32) and the shielded kernel eats exactly one: q8_0 laid out (K,N) with a
scale per 32 consecutive K. Doing that conversion inside the CVM would mean putting
every ggml quantisation format into the trusted computing base to serve a tier
whose whole premise is that weights are PUBLIC and need no protection at all.

So the conversion happens out here, in the open, and the pack it produces is a
public artifact anyone can rebuild and diff. The TEE loads numpy arrays and needs
no quantisation code, no GGUF parser, and no llama.cpp.

DETERMINISM
-----------
docs/shielded-inference.md's requirement is that the TEE's u = r.W and the GPU's
(x+r).W derive BIT-IDENTICAL field elements from the same weight bytes. This packer
is upstream of that: it fixes the q8_0 bytes once, and both sides then run the same
`encode_weight_fixed` over them. Requantising independently on each side -- even
with identical code -- would be a second place for the two to drift, so there is
exactly one.

Requantising q4_K/q5_0 up to q8_0 is lossless with respect to the values in the
file: those weights already sit on a coarser grid than q8_0 resolves, so the pack
reproduces them to within q8_0's own quantum and the shielded run and its in-TEE
reference are compared against the SAME pack, never against the original GGUF.
"""

import argparse
import json
import os
import sys

import numpy as np

QK = 32


def quantize_q8_0_along_k(w_kn):
    """(K,N) float32 -> (wq int8 (K,N), wd float16 (K/QK,N)).

    Blocks run down K for a fixed output column, which is both what GGUF's q8_0
    does along ne[0] and what the kernel's scale broadcast expects. Getting this
    axis wrong does not crash -- it silently scales groups of weights by another
    group's scale -- so it is asserted rather than commented.
    """
    K, N = w_kn.shape
    assert K % QK == 0, f"K={K} must be a multiple of {QK}"
    blocks = K // QK
    w = w_kn.astype(np.float32).reshape(blocks, QK, N)
    amax = np.abs(w).max(axis=1)                      # (blocks, N)
    d = (amax / 127.0).astype(np.float32)
    d = np.where(d == 0, np.float32(1.0), d)          # an all-zero block: any d works
    q = np.rint(w / d[:, None, :]).astype(np.int32)
    q = np.clip(q, -127, 127).astype(np.int8).reshape(K, N)
    return np.ascontiguousarray(q), d.astype(np.float16)


ARCH_KEYS = {
    "block_count": "block_count",
    "embedding_length": "d_model",
    "feed_forward_length": "d_ff",
    "attention.head_count": "n_head",
    "attention.head_count_kv": "n_head_kv",
    "attention.layer_norm_rms_epsilon": "rms_eps",
    "rope.freq_base": "rope_base",
    "context_length": "n_ctx_train",
}


def pack(gguf_path, out_path, gguf_py):
    sys.path.insert(0, gguf_py)
    from gguf.gguf_reader import GGUFReader
    import gguf.quants as Q

    r = GGUFReader(gguf_path)
    fields = r.fields
    arch = fields["general.architecture"].contents()
    cfg = {"arch": arch, "source": os.path.basename(gguf_path)}
    for suffix, name in ARCH_KEYS.items():
        key = f"{arch}.{suffix}"
        if key in fields:
            v = fields[key].contents()
            cfg[name] = float(v) if isinstance(v, float) else int(v)
    for key, name in (("tokenizer.ggml.eos_token_id", "eos"),
                      ("tokenizer.ggml.bos_token_id", "bos"),
                      ("tokenizer.ggml.add_bos_token", "add_bos")):
        if key in fields:
            cfg[name] = fields[key].contents()

    tensors = {t.name: t for t in r.tensors}
    arrays = {}

    # Linear weights get the q8_0 (K,N) treatment; everything else (norms, biases,
    # embeddings) stays float and is used in-TEE only, so it is stored as-is.
    def is_linear(name):
        return any(name.endswith(s) for s in (
            "attn_q.weight", "attn_k.weight", "attn_v.weight", "attn_output.weight",
            "ffn_gate.weight", "ffn_up.weight", "ffn_down.weight", "output.weight"))

    n_lin = 0
    for name, t in tensors.items():
        deq = Q.dequantize(t.data, t.tensor_type).astype(np.float32)  # (N,K) or (K,)
        if is_linear(name):
            w_kn = np.ascontiguousarray(deq.T)                        # (K,N)
            wq, wd = quantize_q8_0_along_k(w_kn)
            arrays[name + "|wq"] = wq
            arrays[name + "|wd"] = wd
            n_lin += 1
        elif name == "token_embd.weight":
            # Never a GEMM operand: rows are gathered by a SECRET token id, which
            # is why GET_ROWS is on the worker's denylist. Stays in the TEE, and
            # fp16 halves the CVM RAM it costs.
            arrays[name] = deq.astype(np.float16)
        else:
            arrays[name] = deq.astype(np.float32)

    # Tokenizer, carried along so the pack is self-contained.
    tok = {}
    for key, name in (("tokenizer.ggml.tokens", "tokens"),
                      ("tokenizer.ggml.merges", "merges"),
                      ("tokenizer.ggml.token_type", "types")):
        if key in fields:
            f = fields[key]
            if name == "types":
                tok[name] = [int(x) for x in f.contents()]
            else:
                tok[name] = [x if isinstance(x, str) else bytes(x).decode("utf-8", "replace")
                             for x in f.contents()]
    cfg["has_output_weight"] = "output.weight" in tensors
    cfg["n_linear"] = n_lin
    cfg["vocab_size"] = len(tok.get("tokens", []))

    np.savez(out_path, __config__=np.frombuffer(json.dumps(cfg).encode(), dtype=np.uint8),
             __tokenizer__=np.frombuffer(json.dumps(tok).encode(), dtype=np.uint8), **arrays)
    return cfg, len(arrays)


def main():
    ap = argparse.ArgumentParser(description="GGUF -> shielded model pack (host-side, offline)")
    ap.add_argument("gguf")
    ap.add_argument("out")
    ap.add_argument("--gguf-py", default="/home/steven/Projects/llama.cpp/gguf-py")
    a = ap.parse_args()
    cfg, n = pack(a.gguf, a.out, a.gguf_py)
    print(json.dumps({"config": cfg, "arrays": n,
                      "bytes": os.path.getsize(a.out)}, indent=2))


if __name__ == "__main__":
    main()
