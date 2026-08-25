#!/usr/bin/env python3
"""
calibrate.py -- pick each offload site's activation exponent and outlier set.

Produces `<pack>.calib.npz`, a PUBLIC artifact in the same spirit as a GGUF
imatrix: derived from public weights and public text, identical for every user and
every prompt, and rebuildable by anyone who has the pack. Nothing in it depends on
a user's input, which is what makes it safe to treat the numbers inside as public
parameters of the model rather than as a leak.

WHAT IT DECIDES, AND WHY IT HAS TO
-----------------------------------
Two numbers per offload site:

  act_frac    the activation's fixed-point exponent. Fixed per site, never adapted
              per request -- an adaptive exponent would be a public parameter
              computed from secret activations, i.e. a real magnitude leak.
  outliers    the channels the TEE keeps for itself. Measured on Qwen2.5-0.5B,
              ffn_down's activation has median channel magnitude 1.5 and max 443;
              that band alone drives the field product to 1.81x M/2, where it wraps
              and decodes to noise. Holding back four channels drops it to 0.12x.

Both are chosen against a target of 25% of M/2, i.e. two bits of headroom over the
worst thing calibration saw, because calibration text is not the user's text. The
runtime detector in tee.Freivalds is what makes that a safety margin rather than a
hope: if an unseen input overflows anyway, the request aborts instead of returning
plausible noise.

TWO PASSES, BECAUSE THE ORDER MATTERS
--------------------------------------
Pass A measures per-channel magnitudes with nothing held back, which is what ranks
the outliers. Pass B fixes each candidate outlier set and measures the peak product
that would actually be offloaded. Doing it in one pass would rank outliers using
statistics gathered under a different split than the one finally chosen.
"""

import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "kernels"))

from tee import HALF_M, exact_matmul
import model as model_mod
from model import ShieldedModel

# Public text. Deliberately mixed -- prose, chat framing, code, digits -- because
# outlier channels are a property of the model but which ones light up is mildly
# input-dependent, and a single register of text would under-cover them.
CALIB_TEXTS = [
    "<|im_start|>system\nYou are a helpful assistant.<|im_end|>\n"
    "<|im_start|>user\nExplain in one paragraph why the sky appears blue.<|im_end|>\n"
    "<|im_start|>assistant\nSunlight contains every colour, and air scatters the short "
    "wavelengths far more strongly than the long ones, so blue light arrives from every "
    "direction at once while red passes straight through.<|im_end|>",
    "<|im_start|>user\nWrite a Python function that reverses a linked list.<|im_end|>\n"
    "<|im_start|>assistant\ndef reverse(head):\n    prev = None\n    while head:\n"
    "        head.next, prev, head = prev, head, head.next\n    return prev<|im_end|>",
    "The quick brown fox jumps over the lazy dog. 0123456789 -- punctuation, commas; "
    "colons: and (parentheses) all appear here, alongside UPPERCASE and lowercase.",
    "In 1687 Newton published the Principia, which set out three laws of motion and a "
    "law of universal gravitation, and remained the standard account of mechanics for "
    "over two centuries.",
]

K_CANDIDATES = (0, 4, 8, 16, 32)
TARGET = 0.25          # fraction of M/2 the worst calibration product may reach
AF_RANGE = (3, 14)


def calibrate(pack_path, texts=None, verbose=False):
    texts = texts or CALIB_TEXTS
    mdl = ShieldedModel(pack_path, link=None)
    id_sets = [mdl.tok.encode(t) for t in texts]

    # ---- pass A: rank channels ------------------------------------------
    chan = {}

    def probe_a(self, names, x_real):
        key = names[0]
        c = np.abs(x_real).max(axis=0)
        chan[key] = np.maximum(chan[key], c) if key in chan else c
        return [x_real.astype(np.float64)
                @ (self.weights[n].w_fixed_i8.astype(np.float64) / float(1 << self.weights[n].f_w))
                for n in names]

    ShieldedModel.linear = probe_a
    for ids in id_sets:
        mdl.forward(ids, list(range(len(ids))), mdl.new_cache())

    outlier_sets = {k: {} for k in K_CANDIDATES}
    for key, c in chan.items():
        order = np.argsort(-c)
        for k in K_CANDIDATES:
            outlier_sets[k][key] = np.sort(order[:k]).astype(np.int64) if k else np.zeros(0, np.int64)

    # ---- pass B: peak offloaded product per candidate --------------------
    peaks = {k: {} for k in K_CANDIDATES}
    REF_AF = 8

    def probe_b(self, names, x_real):
        key = names[0]
        xq = np.rint(x_real.astype(np.float64) * (1 << REF_AF)).astype(np.int64)
        for k in K_CANDIDATES:
            idx = outlier_sets[k][key]
            xk = xq.copy()
            if idx.size:
                xk[:, idx] = 0
            p = max(int(np.abs(exact_matmul(xk, self.weights[n].w_fixed_i8)).max())
                    for n in names)
            peaks[k][key] = max(peaks[k].get(key, 0), p)
        return [x_real.astype(np.float64)
                @ (self.weights[n].w_fixed_i8.astype(np.float64) / float(1 << self.weights[n].f_w))
                for n in names]

    ShieldedModel.linear = probe_b
    for ids in id_sets:
        mdl.forward(ids, list(range(len(ids))), mdl.new_cache())

    # ---- choose (k, act_frac) per site -----------------------------------
    limit = TARGET * HALF_M
    chosen, arrays = {}, {}
    for key in chan:
        best = None
        for k in K_CANDIDATES:
            p = peaks[k][key]
            if p <= 0:
                af = AF_RANGE[1]
            else:
                af = REF_AF + int(np.floor(np.log2(limit / p)))
                af = max(AF_RANGE[0], min(AF_RANGE[1], af))
            # Smallest k that reaches the best exponent: holding back channels is
            # cheap but not free, and every held-back channel is TEE work.
            if best is None or af > best[1]:
                best = (k, af)
        k, af = best
        chosen[key] = {"act_frac": int(af), "k": int(k),
                       "peak_ref": int(peaks[k][key]),
                       "headroom": float(HALF_M / max(1, peaks[k][key] * 2.0 ** (af - REF_AF)))}
        if k:
            arrays[key + "|outliers"] = outlier_sets[k][key]
        if verbose:
            print(f"{key:34s} k={k:3d} act_frac={af:3d} "
                  f"headroom={chosen[key]['headroom']:5.2f}x")

    meta = {"act_frac": {k: v["act_frac"] for k, v in chosen.items()},
            "detail": chosen, "target": TARGET, "ref_af": REF_AF,
            "texts": len(texts), "tokens": sum(len(i) for i in id_sets)}
    out = os.path.splitext(pack_path)[0] + ".calib.npz"
    np.savez(out, __meta__=np.frombuffer(json.dumps(meta).encode(), dtype=np.uint8), **arrays)
    return out, meta


def main():
    ap = argparse.ArgumentParser(description="calibrate a shielded pack (public, offline)")
    ap.add_argument("pack")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    out, meta = calibrate(a.pack, verbose=a.verbose)
    d = meta["detail"]
    import collections
    by_site = collections.defaultdict(list)
    for key, v in d.items():
        by_site[key.split(".")[-2]].append(v)
    print(json.dumps({
        "out": out, "tokens": meta["tokens"],
        "sites": {s: {"k": sorted({x["k"] for x in v}),
                      "act_frac": sorted({x["act_frac"] for x in v}),
                      "min_headroom": round(min(x["headroom"] for x in v), 2)}
                  for s, v in by_site.items()}}, indent=2))


if __name__ == "__main__":
    main()
