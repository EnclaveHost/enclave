#!/usr/bin/env python3
"""
model.py -- the TEE-side executor. A real transformer, with every linear op
offloaded to an untrusted GPU and everything else kept inside.

This is the piece REPORT.md's "what is not measured" list opens with: "No
end-to-end shielded run. Every overhead figure is a primitive measurement or
arithmetic on primitives." Everything below the linear ops was already proven in
reference/shielded_ref.py at toy scale; this runs the same construction over a real
GGUF model, against a real socket, against a real card.

OP PLACEMENT -- the table from docs/shielded-inference.md, in code
------------------------------------------------------------------
OFFLOADED (masked, verified):  attn_q, attn_k, attn_v, attn_output,
                               ffn_gate, ffn_up, ffn_down, output
IN-TEE, ALWAYS:                embedding lookup (GET_ROWS is keyed by a SECRET
                               token id), rms_norm, rope, the attention product
                               itself, softmax, silu, residual adds, sampling.

Decode attention is in-TEE permanently and that is not a v1 simplification:
reference/shielded_ref.py runs the TwinShield recovery attack and it SUCCEEDS at
m=1, 2 and 4, and 4 is a real GQA group size. The KV cache never leaves either --
it is derived from the prompt, and the worker's op denylist refuses FLASH_ATTN_EXT
by name.

EQUIVALENCE
-----------
`backend="tee"` runs the identical arithmetic with the offload replaced by a local
int64 matmul over the same w_fixed. Both paths quantise the activation the same
way and both consume the same pack, so a correct shielded run must reproduce the
in-TEE run BIT-EXACTLY -- not "to within a tolerance". That is the test e2e.py
runs, and a tolerance would hide exactly the bugs it exists to catch.
"""

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "kernels"))

from tee import FRAC, PublicWeight, balanced, exact_matmul
from tokenizer import BPETokenizer

LINEAR_SUFFIXES = ("attn_q.weight", "attn_k.weight", "attn_v.weight",
                   "attn_output.weight", "ffn_gate.weight", "ffn_up.weight",
                   "ffn_down.weight", "output.weight")


def rms_norm(x, w, eps):
    v = x.astype(np.float32)
    return (v / np.sqrt((v * v).mean(axis=-1, keepdims=True) + eps)) * w


def silu(x):
    return x / (1.0 + np.exp(-x, dtype=np.float32))


def softmax(x, axis=-1):
    z = x - x.max(axis=axis, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=axis, keepdims=True)


class ShieldedModel:
    """A qwen2-family decoder whose GEMMs live on someone else's GPU."""

    def __init__(self, pack_path, link=None, prefill_bucket=32, verbose=False):
        self.z = np.load(pack_path, allow_pickle=False)
        self.cfg = json.loads(bytes(self.z["__config__"]).decode())
        tok = json.loads(bytes(self.z["__tokenizer__"]).decode())
        self.tok = BPETokenizer(tok["tokens"], tok.get("merges", []), tok.get("types"))
        self.link = link
        self.verbose = verbose
        c = self.cfg
        self.L = c["block_count"]
        self.d = c["d_model"]
        self.n_head = c["n_head"]
        self.n_kv = c["n_head_kv"]
        self.hd = self.d // self.n_head
        self.eps = c["rms_eps"]
        self.rope_base = c["rope_base"]
        self.gqa = self.n_head // self.n_kv
        self.P = prefill_bucket

        self.embd = self.z["token_embd.weight"]           # (vocab, d) fp16, TEE-only
        self.f32 = {}                                      # norms + biases, TEE-only
        for k in self.z.files:
            if k.startswith("__") or "|" in k or k == "token_embd.weight":
                continue
            self.f32[k] = self.z[k]

        self.weights = {}      # name -> PublicWeight
        self.node = {}         # name -> node index on the worker
        self.calib = {}        # group key -> (act_frac, outlier channel indices)
        self._load_calibration(pack_path)
        self._build()

    # -- setup -------------------------------------------------------------
    GROUPS = (("attn_q", ("attn_q", "attn_k", "attn_v")),
              ("attn_output", ("attn_output",)),
              ("ffn_gate", ("ffn_gate", "ffn_up")),
              ("ffn_down", ("ffn_down",)))

    def group_key(self, layer, site):
        """The name a group is calibrated under: the first weight in it. q/k/v and
        gate/up share one activation, so they share one exponent and one outlier
        set by construction, not by coincidence."""
        for head, members in self.GROUPS:
            if site in members:
                return f"blk.{layer}.{head}.weight"
        return site

    def _load_calibration(self, pack_path):
        side = os.path.splitext(pack_path)[0] + ".calib.npz"
        self.calib_path = side
        if not os.path.exists(side):
            return
        z = np.load(side, allow_pickle=False)
        meta = json.loads(bytes(z["__meta__"]).decode())
        for key, af in meta["act_frac"].items():
            idx = z[key + "|outliers"] if (key + "|outliers") in z.files \
                else np.zeros(0, dtype=np.int64)
            self.calib[key] = (int(af), idx.astype(np.int64))
        self.calib_meta = meta

    def set_calibration(self, calib, meta=None):
        self.calib = calib
        self.calib_meta = meta or {}

    def _names(self):
        for l in range(self.L):
            for s in ("attn_q", "attn_k", "attn_v", "attn_output",
                      "ffn_gate", "ffn_up", "ffn_down"):
                yield f"blk.{l}.{s}.weight"
        if self.cfg.get("has_output_weight"):
            yield "output.weight"

    def _build(self):
        """Encode every linear weight once, and register it as one graph node.

        The per-tensor exponent f_w is chosen here, from public weights only. It
        is reported in `exponents` because a tensor that needed an unusually small
        f_w is the first place to look when the magnitude guard trips.
        """
        for name in self._names():
            wq = self.z[name + "|wq"]
            wd = self.z[name + "|wd"]
            self.weights[name] = PublicWeight(name, wq, wd)
        if self.link is None:
            return
        for l in range(self.L):
            qn = f"blk.{l}.attn_q.weight"
            self.node[qn] = self.link.register(self.weights[qn], (1, self.P))
            for s in ("attn_k", "attn_v"):
                n = f"blk.{l}.{s}.weight"
                self.node[n] = self.link.register(self.weights[n], (1, self.P),
                                                  share_x_with=self.node[qn])
            n = f"blk.{l}.attn_output.weight"
            self.node[n] = self.link.register(self.weights[n], (1, self.P))
            gn = f"blk.{l}.ffn_gate.weight"
            self.node[gn] = self.link.register(self.weights[gn], (1, self.P))
            un = f"blk.{l}.ffn_up.weight"
            self.node[un] = self.link.register(self.weights[un], (1, self.P),
                                               share_x_with=self.node[gn])
            n = f"blk.{l}.ffn_down.weight"
            self.node[n] = self.link.register(self.weights[n], (1, self.P))
        if self.cfg.get("has_output_weight"):
            # Only the final position's logits are ever needed, so the head is a
            # decode-shaped node even during prefill. At vocab 151936 that is the
            # difference between a 0.6 MB read-back and a 39 MB one.
            self.node["output.weight"] = self.link.register(
                self.weights["output.weight"], (1,))

    @property
    def exponents(self):
        return {n: w.f_w for n, w in self.weights.items()}

    # -- the linear op -----------------------------------------------------
    def linear(self, names, x_real):
        """Offload a group of weights sharing one activation. Returns float arrays.

        OUTLIER SPLITTING -- the thing that makes this work on a real model.
        --------------------------------------------------------------------
        Measured on Qwen2.5-0.5B: ffn_down's activation has a median channel
        magnitude of 1.5 and a max of 443. That single 300x outlier band pushes the
        field product to 1.81x M/2, i.e. it WRAPS, and a wrapped product decodes to
        noise -- which is precisely REPORT.md's open risk #3 ("~1 bit of margin
        against 10^3x outlier channels") firing on real data rather than in a
        sensitivity table.

        Removing the top FOUR channels drops the peak from 1.81x to 0.12x. So those
        channels are not offloaded: the TEE keeps them and computes their
        contribution itself, in plain int64 where nothing can wrap, and adds it to
        the GPU's partial product. The cost is k*N multiplies against the offloaded
        (K-k)*N -- 0.08% at k=4, K=4864 -- and the direction of travel is the safe
        one, since it moves work INTO the enclave.

        This leaks nothing new. The outlier channel INDICES are a static property of
        the public weights, calibrated offline on public text and shipped in the
        pack exactly like an imatrix; they are identical for every prompt and every
        user. The VALUES in those channels stay in the TEE and are never sent at
        all. Likewise the per-site activation exponent: it is a public model
        constant, not a per-request quantity derived from the user's activations --
        an adaptive one would leak activation magnitude, and is refused.

        The runtime wrap detector in tee.Freivalds stays armed regardless. Calibration
        makes an overflow unlikely; it is the detector that makes it impossible to
        miss one.
        """
        key = names[0]
        af, out_idx = self.calib_for(key)
        if self.link is None and getattr(self, "float_probe", False):
            # Diagnostic only: same weights, no activation quantisation. Isolates
            # "the fixed-point budget is too tight" from "the forward pass is wrong".
            return [x_real.astype(np.float64) @ (self.weights[n].w_fixed_i8.astype(np.float64)
                                                 / float(1 << self.weights[n].f_w))
                    for n in names]

        x_field = np.rint(x_real.astype(np.float64) * (1 << af)).astype(np.int64)
        if out_idx.size:
            x_tee = x_field[:, out_idx]
            x_gpu = x_field.copy()
            x_gpu[:, out_idx] = 0
        else:
            x_tee, x_gpu = None, x_field

        if self.link is not None:
            ys = self.link.gemm_shared([self.node[n] for n in names], x_gpu)
        else:
            ys = [balanced(exact_matmul(x_gpu, self.weights[n].w_fixed_i8))
                  for n in names]

        out = []
        for n, y in zip(names, ys):
            if x_tee is not None:
                # int64, in the TEE, outside the field: this term cannot wrap, so
                # the outliers that would have broken Z_M are exactly the ones the
                # field never has to hold.
                y = y + exact_matmul(x_tee, self.weights[n].w_fixed_i8[out_idx, :])
            out.append(y.astype(np.float64)
                       / float(1 << (af + self.weights[n].f_w)))
        return out

    def calib_for(self, key):
        c = self.calib.get(key)
        if c is None:
            raise KeyError(
                f"no calibration for {key}. Run shielded/calibrate.py over the pack: "
                f"without it the activation exponent and outlier set are guesses, and "
                f"a wrong guess wraps Z_M silently on the sites that matter.")
        return c

    def _bias(self, name):
        b = self.f32.get(name)
        return 0.0 if b is None else b.astype(np.float64)

    # -- rope --------------------------------------------------------------
    def _rope(self, t, pos):
        """NeoX-style rotary: pairs (i, i + hd/2). qwen2 is NEOX in llama.cpp
        (llama-model.cpp rope_type), and the NORM-style interleaving would produce
        fluent-looking but wrong text -- the failure mode that is hardest to spot
        by reading output."""
        half = self.hd // 2
        inv = 1.0 / (self.rope_base ** (np.arange(half, dtype=np.float64) / half))
        ang = np.asarray(pos, dtype=np.float64)[:, None] * inv[None, :]
        cos, sin = np.cos(ang)[:, None, :], np.sin(ang)[:, None, :]
        a, b = t[..., :half], t[..., half:]
        return np.concatenate([a * cos - b * sin, a * sin + b * cos], axis=-1)

    # -- forward -----------------------------------------------------------
    def forward(self, ids, positions, cache, want_logits=True):
        """One batch of m tokens. `cache` is a per-layer list of (k, v) grown in
        place; it is TEE RAM and never crosses the boundary in any form."""
        m = len(ids)
        x = self.embd[np.asarray(ids)].astype(np.float64)

        for l in range(self.L):
            h = rms_norm(x, self.f32[f"blk.{l}.attn_norm.weight"], self.eps)
            qn, kn, vn = (f"blk.{l}.attn_q.weight", f"blk.{l}.attn_k.weight",
                          f"blk.{l}.attn_v.weight")
            q, k, v = self.linear([qn, kn, vn], h)
            q = q + self._bias(f"blk.{l}.attn_q.bias")
            k = k + self._bias(f"blk.{l}.attn_k.bias")
            v = v + self._bias(f"blk.{l}.attn_v.bias")
            q = self._rope(q.reshape(m, self.n_head, self.hd), positions)
            k = self._rope(k.reshape(m, self.n_kv, self.hd), positions)
            v = v.reshape(m, self.n_kv, self.hd)

            # KV insertion happens only after the producing GEMMs verified, which
            # link.gemm_shared guarantees by raising before it returns. A corrupt
            # activation costs one token; a corrupt cache entry poisons every
            # future token that attends to it.
            if cache[l][0] is None:
                cache[l][0], cache[l][1] = k, v
            else:
                cache[l][0] = np.concatenate([cache[l][0], k], axis=0)
                cache[l][1] = np.concatenate([cache[l][1], v], axis=0)
            kk, vv = cache[l]
            n_past = kk.shape[0]

            # Attention, entirely in-TEE. Offloading it at decode is broken, not
            # merely unimplemented (shielded_ref.check_twinshield).
            scale = 1.0 / np.sqrt(self.hd)
            out = np.empty((m, self.n_head, self.hd), dtype=np.float64)
            base = n_past - m
            causal = np.arange(n_past)[None, :] > (base + np.arange(m))[:, None]
            for hgroup in range(self.n_kv):
                ks = kk[:, hgroup, :]
                vs = vv[:, hgroup, :]
                for j in range(self.gqa):
                    hh = hgroup * self.gqa + j
                    scores = (q[:, hh, :] @ ks.T) * scale
                    scores = np.where(causal, -np.inf, scores)
                    out[:, hh, :] = softmax(scores, axis=-1) @ vs
            o, = self.linear([f"blk.{l}.attn_output.weight"], out.reshape(m, self.d))
            x = x + o

            h = rms_norm(x, self.f32[f"blk.{l}.ffn_norm.weight"], self.eps)
            g, u = self.linear([f"blk.{l}.ffn_gate.weight", f"blk.{l}.ffn_up.weight"], h)
            f, = self.linear([f"blk.{l}.ffn_down.weight"], silu(g) * u)
            x = x + f

        if not want_logits:
            return None
        h = rms_norm(x[-1:], self.f32["output_norm.weight"], self.eps)
        if self.cfg.get("has_output_weight"):
            logits, = self.linear(["output.weight"], h)
        else:
            logits = h @ self.embd.astype(np.float64).T
        return logits[0]

    # -- generation --------------------------------------------------------
    def new_cache(self):
        return [[None, None] for _ in range(self.L)]

    def generate(self, prompt_ids, max_tokens=16, greedy=True, on_token=None):
        """Prefill in public, bucketed chunks, then decode one token at a time."""
        cache = self.new_cache()
        pos = 0
        ids = list(prompt_ids)
        logits = None
        i = 0
        while i < len(ids):
            chunk = ids[i:i + self.P]
            # Shapes are public and bucketed by design, so a short tail runs at
            # m=1 rather than inventing an undeclared bucket.
            if len(chunk) == self.P:
                logits = self.forward(chunk, list(range(pos, pos + len(chunk))), cache)
                pos += len(chunk)
                i += len(chunk)
            else:
                for t in chunk:
                    logits = self.forward([t], [pos], cache)
                    pos += 1
                    i += 1

        out = []
        eos = self.cfg.get("eos")
        for _ in range(max_tokens):
            nxt = int(np.argmax(logits)) if greedy else int(
                np.random.choice(len(logits), p=softmax(logits)))
            if nxt == eos:
                break
            out.append(nxt)
            if on_token:
                on_token(nxt)
            logits = self.forward([nxt], [pos], cache)
            pos += 1
        return out
