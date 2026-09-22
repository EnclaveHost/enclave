#!/usr/bin/env python3
"""Read a quality-compare.sh output directory and say how far the masked path drifted from the unmasked one.

Greedy decoding compounds a single flipped argmax into every token after it, so the honest statistic is WHERE the
two arms first part, not what fraction of characters coincide: a pair that agrees for 40 characters and then writes
two different but equally correct sentences is a much better result than the character rate would suggest, and a
pair that agrees for 3 characters is a much worse one. Both texts are printed in full so the reader can judge the
tail rather than trust a number about it.

The comparison is against the same GGUF decoded on the CPU, which is a different quantisation, not an oracle:
agreement is evidence the lane arithmetic is faithful, disagreement is not by itself evidence that it is wrong.
"""
import glob, os, re, sys

D = sys.argv[1] if len(sys.argv) > 1 else "/tmp/quality-compare"


def answer(path):
    """The turn's reply, untruncated, or None with the reason the run produced no comparable text."""
    if not os.path.exists(path):
        return None, "missing"
    txt = open(path, errors="replace").read()
    m = re.findall(r"LOCAL turn \d+ A: (.*)", txt)
    if not m:
        for bad in ("HOST FAIL", "VM error", "LOCAL failed", "PHONE NOT AWAKE"):
            if bad in txt:
                return None, bad
        return None, "no A: line"
    return m[0].rstrip(), None


def rate(path):
    m = re.findall(r"([\d.]+) tok/s", open(path, errors="replace").read()) if os.path.exists(path) else []
    return m[-1] if m else "?"


def main():
    ids = sorted({os.path.basename(p).split(".")[0] for p in glob.glob(os.path.join(D, "*.prompt"))})
    if not ids:
        print(f"no runs in {D}")
        return 1
    rows = []
    for i in ids:
        prompt = open(os.path.join(D, f"{i}.prompt"), errors="replace").read().strip()
        a, ea = answer(os.path.join(D, f"{i}.tpu.log"))
        b, eb = answer(os.path.join(D, f"{i}.cpu.log"))
        if a is None or b is None:
            print(f"--- {i} SKIPPED: tpu={ea or 'ok'} cpu={eb or 'ok'}\n    {prompt}")
            continue
        k = 0
        while k < min(len(a), len(b)) and a[k] == b[k]:
            k += 1
        rows.append((i, prompt, a, b, k))
    if not rows:
        print("nothing comparable")
        return 1
    print(f"{'#':3} {'first divergence':>16} {'tpu len':>8} {'cpu len':>8}  prompt")
    for i, prompt, a, b, k in rows:
        mark = "identical" if k == len(a) == len(b) else f"char {k}"
        print(f"{i:3} {mark:>16} {len(a):8} {len(b):8}  {prompt[:60]}")
    ident = sum(1 for r in rows if r[4] == len(r[2]) == len(r[3]))
    pref = sum(r[4] for r in rows) / sum(min(len(r[2]), len(r[3])) for r in rows)
    print(f"\n{ident}/{len(rows)} replies identical; common prefix = {pref*100:.0f}% of the shorter reply")
    for i, prompt, a, b, k in rows:
        print(f"\n--- {i}  {prompt}")
        print(f"    agree: {a[:k]!r}")
        print(f"    TPU  : {a[k:]!r}")
        print(f"    CPU  : {b[k:]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
