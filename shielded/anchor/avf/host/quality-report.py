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


def status(path):
    """eos = the model stopped on its own; budget = it hit the token cap and the answer is TRUNCATED."""
    if not os.path.exists(path):
        return "?"
    m = re.findall(r"status=(\w+)", open(path, errors="replace").read())
    return m[0] if m else "?"


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
    print(f"{'#':3} {'tpu':>9} {'cpu':>9} {'agreement':>16}  prompt")
    tok, cok, trunc = 0, 0, 0
    for i, prompt, a, b, k in rows:
        mark = "identical" if k == len(a) == len(b) else f"char {k}"
        want = ""
        wp = os.path.join(D, f"{i}.expect")
        if os.path.exists(wp):
            want = open(wp, errors="replace").read().strip()
        # A reply that stopped at the token cap is TRUNCATED: scoring it as a completed task would count a
        # cut-off answer as a success, which is exactly what the 48-token version of this table did.
        sa, sb = status(os.path.join(D, f"{i}.tpu.log")), status(os.path.join(D, f"{i}.cpu.log"))
        ta = (bool(re.search(want, a, re.I)) and sa == "eos") if want else None
        tb = (bool(re.search(want, b, re.I)) and sb == "eos") if want else None
        tok += 1 if ta else 0
        cok += 1 if tb else 0
        trunc += 1 if (sa != "eos" or sb != "eos") else 0
        fa = ("PASS" if ta else "fail") + ("" if sa == "eos" else "/cut")
        fb = ("PASS" if tb else "fail") + ("" if sb == "eos" else "/cut")
        print(f"{i:3} {fa:>9} {fb:>9} {mark:>16}  {prompt[:52]}")
    ident = sum(1 for r in rows if r[4] == len(r[2]) == len(r[3]))
    pref = sum(r[4] for r in rows) / sum(min(len(r[2]), len(r[3])) for r in rows)
    print(f"\nTASK CORRECTNESS (completed AND matching its expectation): tpu {tok}/{len(rows)}, cpu {cok}/{len(rows)}")
    print(f"{trunc} of {len(rows)} prompts had an arm stop at the token cap rather than on its own")
    print(f"DECODE AGREEMENT: {ident}/{len(rows)} replies identical; common prefix = {pref*100:.0f}% of the shorter")
    print("The two measures are separate on purpose: agreement says the arithmetic tracks the baseline,")
    print("correctness says the answer is actually usable. A truncated reply can agree perfectly and do neither.")
    for i, prompt, a, b, k in rows:
        print(f"\n--- {i}  {prompt}")
        print(f"    agree: {a[:k]!r}")
        print(f"    TPU  : {a[k:]!r}")
        print(f"    CPU  : {b[k:]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
