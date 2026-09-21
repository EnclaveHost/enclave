#!/usr/bin/env python3
"""
bench_pads.py -- drive bench_pads over real layer shapes and roll the numbers
up per token. Writes results/<tag>.json and prints Markdown tables.

Sections (each is one --only name):
  layers    every layer shape of the 27B / 9B / 0.5B and the handoff's two
            squares, at B = 1 and B = 8, cold (W.A evicted between pads of
            the same layer), 8 threads; selector-chosen (k, t) for each B
  ksweep    n = m = 16384: k from 128 to 2048 at fixed k.t = 90n, hot and
            cold, 32- and 16-bit W.A storage (handoff section 4.3)
  amode     dense vs dense8 vs toeplitz A at one shape (the cost the handoff
            omitted)
  noise     regular vs random noise positions at one shape
  threads   1 / 4 / 8 / 16 threads on the 27B gate|up shape
  batch     B = 1, 4, 8, 16, 64 on the 27B gate|up shape, batch-aware (k, t)
  token     per-token pad cost for the 27B (64 blocks + lm_head) and the 9B,
            uniform vs LPN, B = 1 and B = 8 -> the refill-bound tok/s ceiling

Cold means LAYERS copies of (W, W.A, A) sized to exceed 4x the box's L3 so a
pad of layer i cannot find layer i's W.A in cache: a token visits every layer
once, so this is the per-token truth. Hot (LAYERS = 1) is what the handoff's
section 4.3 imagines and what a burst of B pads of one layer gets.
"""

import argparse
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lpn_select as sel

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "bench_pads")
L3_BYTES = 64 << 20          # this box: 2 x 32 MB
COLD_TARGET = 4 * L3_BYTES

# blk.0 shapes read from the GGUFs on this box (n = inputs, m = outputs), and
# how many times each appears per token. Fused groups (gate|up, qkv) share one
# pad by rule in the engine, so they are one (n, 2m) layer here.
MODELS = {
    "qwen3.8-27b": {"blocks": 64, "layers": {
        "attn_qkv": (5120, 10240), "attn_gate": (5120, 6144), "ssm_out": (6144, 5120),
        "ffn_gate|up": (5120, 34816), "ffn_down": (17408, 5120)},
        "head": (5120, 248320)},
    "qwen3.5-9b": {"blocks": 32, "layers": {
        "attn_qkv": (4096, 8192), "attn_gate": (4096, 4096), "ssm_out": (4096, 4096),
        "ffn_gate|up": (4096, 24576), "ffn_down": (12288, 4096)},
        "head": (4096, 248320)},
    "qwen2.5-0.5b": {"blocks": 24, "layers": {
        "attn_q": (896, 896), "attn_kv": (896, 256), "attn_o": (896, 896),
        "ffn_gate|up": (896, 9728), "ffn_down": (4864, 896)},
        "head": (896, 151936)},
}
SPEC = {"spec-4096": (4096, 4096), "spec-16384": (16384, 16384)}


def layers_for_cold(n, m, k, ring, a_mode):
    per = n * m + k * m * (ring // 8) + (n * k * 4 if a_mode == "dense" else n * k if a_mode == "dense8" else 0)
    return max(2, min(24, -(-COLD_TARGET // per)))


def run(n, m, k, t, batch=1, threads=8, layers=None, ring=32, a_mode="toeplitz", regular=True, reps=7, verify=True):
    if layers is None:
        layers = layers_for_cold(n, m, k, ring, a_mode)
    cmd = [BIN, "--n", str(n), "--m", str(m), "--k", str(k), "--t", str(t), "--batch", str(batch),
           "--threads", str(threads), "--layers", str(layers), "--reps", str(reps), "--ring", str(ring),
           "--a", a_mode, "--json"]
    if not regular:
        cmd.append("--random")
    if not verify:
        cmd.append("--no-verify")
    env = dict(os.environ, OMP_PROC_BIND="close", OMP_PLACES="cores")
    out = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if out.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)}\n{out.stderr}")
    return json.loads(out.stdout.strip().splitlines()[-1])


def pick(n, m, batch, ring, wbits=8, a_mode="toeplitz", sec=90):
    r = sel.select(n, m, ring_bits=ring, weight_bits=wbits, batch=batch, sec=sec, a_mode=a_mode)
    return r


def fmt_us(s):
    return f"{s * 1e6:.0f}"


def section_layers(res, threads):
    rows = []
    shapes = dict(SPEC)
    for mname, md in MODELS.items():
        for lname, (n, m) in md["layers"].items():
            shapes[f"{mname}/{lname}"] = (n, m)
        shapes[f"{mname}/lm_head"] = md["head"]
    print(f"\n### Layer shapes, cold, {threads} threads, 32-bit ring, toeplitz A\n")
    print("| layer | n | m | B | k | t | plain us/pad | lpn us/pad | speedup | bytes ratio | plain GB/s | lpn GB/s |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for name, (n, m) in shapes.items():
        if m % 64:
            continue
        for B in (1, 4, 8):
            p = pick(n, m, B, 32)
            if p.get("k") is None:
                continue
            r = run(n, m, p["k"], p["t"], batch=B, threads=threads, verify=(B == 1))
            r.update(layer=name, selector=p)
            rows.append(r)
            lpn = r["lpn"]; pl = r["plain"]
            print(f"| {name} | {n} | {m} | {B} | {p['k']} | {p['t']} | {fmt_us(pl['s']/B)} | {fmt_us(lpn['s']/B)} | "
                  f"{r['speedup']:.2f}x | {lpn['bytes']/pl['bytes']:.2f} | {pl['bytes']/pl['s']/1e9:.0f} | {lpn['bytes']/lpn['s']/1e9:.0f} |")
            sys.stdout.flush()
    res["layers"] = rows


def section_ksweep(res, threads):
    n = m = 16384
    rows = []
    print(f"\n### k sweep, n = m = 16384, k.t = 90n, {threads} threads\n")
    print("| ring | k | t | WA MB | plain us | lpn us (cold) | speedup (cold) | wa us cold | wa us hot (L3) | lpn us if W.A hot | speedup if hot | gather us | a_s us |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for ring in (32, 16):
        for k in (128, 192, 256, 384, 512, 768, 1024, 1536, 2048):
            t = -(-90 * n // k)
            cold = run(n, m, k, t, threads=threads, ring=ring, verify=(k == 128))
            lpn_hot = cold["lpn"]["s"] - cold["wa"]["s"] + cold["wa_hot_s"]
            rows.append({"ring": ring, "k": k, "t": t, "cold": cold, "lpn_hot_s": lpn_hot})
            print(f"| {ring} | {k} | {t} | {k*m*(ring//8)/1e6:.1f} | {fmt_us(cold['plain']['s'])} | {fmt_us(cold['lpn']['s'])} | {cold['speedup']:.2f}x | "
                  f"{fmt_us(cold['wa']['s'])} | {fmt_us(cold['wa_hot_s'])} | {fmt_us(lpn_hot)} | {cold['plain']['s']/lpn_hot:.2f}x | {fmt_us(cold['gather']['s'])} | {fmt_us(cold['a_s']['s'])} |")
            sys.stdout.flush()
    res["ksweep"] = rows


def section_amode(res, threads):
    rows = []
    print(f"\n### Public matrix layout, cold, {threads} threads, B = 1\n")
    print("| shape | A | k | t | a_s us | a_s bytes MB | lpn us | plain us | speedup | selector ratio |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for name, (n, m) in (("spec-4096", (4096, 4096)), ("spec-16384", (16384, 16384)), ("27b-gate|up", (5120, 34816))):
        for a_mode in ("dense", "dense8", "toeplitz"):
            p = pick(n, m, 1, 32, a_mode=a_mode)
            r = run(n, m, p["k"], p["t"], threads=threads, a_mode=a_mode, verify=(a_mode != "dense" or n <= 4096))
            r.update(layer=name, selector=p)
            rows.append(r)
            print(f"| {name} | {a_mode} | {p['k']} | {p['t']} | {fmt_us(r['a_s']['s'])} | {r['a_s']['bytes']/1e6:.1f} | {fmt_us(r['lpn']['s'])} | {fmt_us(r['plain']['s'])} | {r['speedup']:.2f}x | {p['ratio']:.2f} |")
            sys.stdout.flush()
    res["amode"] = rows


def section_noise(res, threads):
    rows = []
    print(f"\n### Regular vs random noise positions, cold, {threads} threads\n")
    print("| shape | B | noise | rows read | gather us | lpn us | speedup |")
    print("|---|---|---|---|---|---|---|")
    for name, (n, m) in (("spec-16384", (16384, 16384)), ("27b-down", (17408, 5120))):
        for B in (1, 8):
            p = pick(n, m, B, 32)
            for regular in (True, False):
                r = run(n, m, p["k"], p["t"], batch=B, threads=threads, regular=regular, verify=False)
                r.update(layer=name, selector=p)
                rows.append(r)
                print(f"| {name} | {B} | {'regular' if regular else 'random'} | {r['rows_read']:.0f} / {n} | {fmt_us(r['gather']['s'])} | {fmt_us(r['lpn']['s'])} | {r['speedup']:.2f}x |")
                sys.stdout.flush()
    res["noise"] = rows


def section_threads(res):
    rows = []
    n, m = 5120, 34816
    print("\n### Threads, 27B gate|up (5120 x 34816), cold, B = 1\n")
    print("| threads | k | t | plain us | plain GB/s | lpn us | lpn GB/s | speedup | wa us | gather us | a_s us |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    p = pick(n, m, 1, 32)
    for th in (1, 2, 4, 8, 16):
        r = run(n, m, p["k"], p["t"], threads=th, verify=False)
        r.update(selector=p)
        rows.append(r)
        print(f"| {th} | {p['k']} | {p['t']} | {fmt_us(r['plain']['s'])} | {r['plain']['bytes']/r['plain']['s']/1e9:.0f} | {fmt_us(r['lpn']['s'])} | {r['lpn']['bytes']/r['lpn']['s']/1e9:.0f} | {r['speedup']:.2f}x | {fmt_us(r['wa']['s'])} | {fmt_us(r['gather']['s'])} | {fmt_us(r['a_s']['s'])} |")
        sys.stdout.flush()
    res["threads"] = rows


def section_batch(res, threads):
    rows = []
    n, m = 5120, 34816
    print(f"\n### Batch, 27B gate|up, cold, {threads} threads, batch-aware (k, t)\n")
    print("| B | objective | k | t | plain us/pad | lpn us/pad | speedup | rows read (gather) | plain GMAC/s | lpn GMAC/s |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for B in (1, 4, 8, 16, 64):
        p = pick(n, m, B, 32)
        r = run(n, m, p["k"], p["t"], batch=B, threads=threads, verify=False)
        r.update(selector=p)
        rows.append(r)
        print(f"| {B} | {p['objective']} | {p['k']} | {p['t']} | {fmt_us(r['plain']['s']/B)} | {fmt_us(r['lpn']['s']/B)} | {r['speedup']:.2f}x | {r['rows_read']:.0f} ({r['gather_strategy']}) | {r['plain']['flops']/r['plain']['s']/1e9:.0f} | {r['lpn']['flops']/r['lpn']['s']/1e9:.0f} |")
        sys.stdout.flush()
    res["batch"] = rows


def section_token(res, threads):
    """Per-token pad cost: sum over the model's layers of the per-pad cost,
    measured cold, times the block count. The refill-bound ceiling is
    1 / (per-token pad time) on `threads` cores."""
    out = {}
    print(f"\n### Per-token pad cost, cold, {threads} threads\n")
    print("| model | B | uniform ms/token | lpn ms/token | speedup | uniform ceiling tok/s | lpn ceiling tok/s | lpn layers on plain |")
    print("|---|---|---|---|---|---|---|---|")
    for mname, md in MODELS.items():
        for B in (1, 4, 8, 16):
            tot_plain = tot_lpn = 0.0
            fallbacks = 0
            per_layer = []
            for lname, (n, m) in list(md["layers"].items()) + [("lm_head", md["head"])]:
                if m % 64:
                    continue
                p = pick(n, m, B, 32)
                r = run(n, m, max(p.get("k") or 64, 1), max(p.get("t") or 1, 1), batch=B, threads=threads, verify=False)
                mult = 1 if lname == "lm_head" else md["blocks"]
                plain_s = r["plain"]["s"]
                lpn_s = r["lpn"]["s"] if p["mode"] == "lpn" else plain_s
                if p["mode"] != "lpn":
                    fallbacks += 1
                tot_plain += plain_s * mult
                tot_lpn += lpn_s * mult
                per_layer.append({"layer": lname, "n": n, "m": m, "mult": mult, "selector": p, "bench": r})
            out[f"{mname}/B{B}"] = {"plain_s_per_token": tot_plain / B, "lpn_s_per_token": tot_lpn / B,
                                    "fallbacks": fallbacks, "per_layer": per_layer}
            print(f"| {mname} | {B} | {tot_plain/B*1e3:.1f} | {tot_lpn/B*1e3:.1f} | {tot_plain/tot_lpn:.2f}x | "
                  f"{B/tot_plain:.1f} | {B/tot_lpn:.1f} | {fallbacks} |")
            sys.stdout.flush()
    res["token"] = out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", default=None)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--tag", default=time.strftime("%Y%m%d-%H%M"))
    args = ap.parse_args()
    if not os.path.exists(BIN):
        sys.exit(f"build first: gcc -O3 -march=native -fopenmp {HERE}/bench_pads.c -o {BIN}")
    sections = {
        "layers": lambda r: section_layers(r, args.threads),
        "ksweep": lambda r: section_ksweep(r, args.threads),
        "amode": lambda r: section_amode(r, args.threads),
        "noise": lambda r: section_noise(r, args.threads),
        "threads": section_threads,
        "batch": lambda r: section_batch(r, args.threads),
        "token": lambda r: section_token(r, args.threads),
    }
    res = {"tag": args.tag, "threads": args.threads, "host": os.uname().nodename}
    for name in (args.only or list(sections)):
        t0 = time.time()
        sections[name](res)
        print(f"\n({name}: {time.time() - t0:.0f}s)")
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    path = os.path.join(HERE, "results", f"{args.tag}.json")
    with open(path, "w") as f:
        json.dump(res, f)
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
