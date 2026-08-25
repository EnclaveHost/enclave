#!/usr/bin/env python3
"""
e2e.py -- the end-to-end shielded run.

REPORT.md's "what is not measured" list opens with: "No end-to-end shielded run.
Every overhead figure is a primitive measurement or arithmetic on primitives.
Transport, mask staging, and verification are modelled, not observed." This closes
that item. It runs a real GGUF model, generating real tokens, with every linear op
masked and executed on a GPU the enclave does not trust, and it observes every term
the report had to model.

THE TEST IS EQUIVALENCE, NOT PLAUSIBILITY
------------------------------------------
Generating fluent text proves very little: a masking bug that perturbs activations
slightly still produces fluent text, and a wrapped field product produces confident
nonsense that reads like a small model having a bad day. So the harness runs the
SAME prompt twice -- once with the GPU attached, once with the offload replaced by
a local integer matmul over the same weights -- and requires the two token streams
to be IDENTICAL. Exactness is the claim the construction actually makes (Slalom
recovery is exact in Z_M, not approximate), so anything less than bit-equality is a
bug, and a tolerance would hide exactly the bugs this exists to catch.

WHAT IT REPORTS
---------------
Per-token wall clock split into the four terms the design budgets separately: mask
staging, transport + GPU, the TEE-side refill u = r*W, and verification. Plus the
adversary's view: how many bytes crossed the boundary and what they were.
"""

import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "kernels"))

from model import ShieldedModel
from tee import WorkerLink

DEFAULT_PROMPTS = [
    "What is the capital of France?",
    "Write one sentence about the ocean.",
    "What is 17 plus 25?",
]


def chat(p):
    return ("<|im_start|>system\nYou are a helpful assistant.<|im_end|>\n"
            f"<|im_start|>user\n{p}<|im_end|>\n<|im_start|>assistant\n")


def run(pack, host, port, prompts, max_tokens, prefill, verify, compare, quiet=False):
    def say(*a):
        if not quiet:
            print(*a, flush=True)

    link = WorkerLink(host=host, port=port, verify=verify)
    t0 = time.time()
    mdl = ShieldedModel(pack, link=link, prefill_bucket=prefill)
    t_encode = time.time() - t0
    say(f"[tee]    pack {os.path.basename(pack)}: {mdl.L} layers, d={mdl.d}, "
        f"{len(mdl.weights)} linear tensors encoded in {t_encode:.1f}s")
    if not mdl.calib:
        raise SystemExit("pack has no calibration sidecar; run shielded/calibrate.py first")

    info = link.connect()
    say(f"[worker] {info['device']}, {info['vram_total'] / 2**30:.1f} GiB, "
        f"proto {'.'.join(map(str, info['version']))}")
    t0 = time.time()
    link.upload_weights()
    t_up = time.time() - t0
    inst = link.install()
    say(f"[worker] uploaded {link._wbytes / 2**20:.0f} MiB of PUBLIC weights in {t_up:.1f}s; "
        f"installed {inst['nodes']} nodes, activation arena {link._abytes / 2**20:.0f} MiB")

    results = []
    for p in prompts:
        ids = mdl.tok.encode(chat(p))
        t0 = time.time()
        out = mdl.generate(ids, max_tokens=max_tokens)
        dt = time.time() - t0
        text = mdl.tok.decode(out)
        rec = {"prompt": p, "prompt_tokens": len(ids), "generated": len(out),
               "text": text, "seconds": round(dt, 2),
               "tok_per_s": round(len(out) / dt, 3) if dt else None}
        say(f"\n  Q: {p}\n  A: {text!r}\n     {len(ids)} prompt + {len(out)} generated "
            f"in {dt:.1f}s ({rec['tok_per_s']} tok/s)")
        results.append(rec)

    link.close()          # close() flushes the wire counters into stats
    st = dict(link.stats)

    equivalence = None
    if compare:
        say("\n[check] re-running the same prompts entirely in-TEE for equivalence")
        ref = ShieldedModel(pack, link=None, prefill_bucket=prefill)
        equivalence = []
        for rec, p in zip(results, prompts):
            ids = ref.tok.encode(chat(p))
            t0 = time.time()
            out = ref.generate(ids, max_tokens=max_tokens)
            same = ref.tok.decode(out) == rec["text"]
            equivalence.append({"prompt": p, "identical": same,
                                "tee_seconds": round(time.time() - t0, 2),
                                "tee_text": ref.tok.decode(out)})
            say(f"  {'IDENTICAL' if same else 'DIVERGED '}  {p}")
            if not same:
                say(f"    shielded: {rec['text']!r}\n    in-TEE  : {ref.tok.decode(out)!r}")

    total_tokens = sum(r["generated"] for r in results)
    report = {
        "model": os.path.basename(pack),
        "worker": {"device": info["device"], "host": f"{host}:{port}"},
        "results": results,
        "equivalence": equivalence,
        "all_identical": None if equivalence is None else all(e["identical"] for e in equivalence),
        "offload": {
            "exchanges": st["exchanges"],
            "round_trips": st["round_trips"],
            "offloaded_macs": st["offloaded_macs"],
            "gmac": round(st["offloaded_macs"] / 1e9, 2),
            "peak_abs_y": st["peak_y"],
            "verify_failures": st["verify_fail"],
            "bytes_to_gpu": st["bytes_out"],
            "bytes_from_gpu": st["bytes_in"],
        },
        "seconds": {k: round(st.get(k, 0.0), 2)
                    for k in ("t_mask", "t_wire", "t_refill", "t_verify")},
    }
    if total_tokens:
        report["per_token_ms"] = {
            k.replace("t_", ""): round(st.get(k, 0.0) * 1e3 / total_tokens, 2)
            for k in ("t_mask", "t_wire", "t_refill", "t_verify")}
        report["per_token_ms"]["exchanges"] = round(st["exchanges"] / total_tokens, 1)
    return report


def main():
    ap = argparse.ArgumentParser(description="end-to-end shielded inference")
    ap.add_argument("pack")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9500)
    ap.add_argument("--prompt", action="append", default=None)
    ap.add_argument("--max-tokens", type=int, default=16)
    ap.add_argument("--prefill", type=int, default=16)
    ap.add_argument("--no-verify", action="store_true",
                    help="disable Freivalds; for measuring its cost ONLY, never for use")
    ap.add_argument("--no-compare", action="store_true")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()
    rep = run(a.pack, a.host, a.port, a.prompt or DEFAULT_PROMPTS, a.max_tokens,
              a.prefill, not a.no_verify, not a.no_compare)
    print("\n" + json.dumps(rep, indent=2))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(rep, f, indent=2)
    if rep["all_identical"] is False:
        raise SystemExit("EQUIVALENCE FAILED")


if __name__ == "__main__":
    main()
