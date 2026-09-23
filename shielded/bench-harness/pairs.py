#!/usr/bin/env python3
"""Matched-pair A/B, validating each arm from its OWN artifacts.

Two rules this enforces, both learned the hard way tonight:

1. A pair with one contaminated arm is not a pair. Drop BOTH. Dropping only the
   bad arm leaves an orphan that a median absorbs silently.

2. The absence of an INTRUDER marker in a queue log is not evidence a run was
   valid. The queue log may not exist, may not have been written, or may not
   cover the field that matters. So every arm is checked against its own
   .meta, .err and .json: exit status, refusals, local fallback, verification
   failures, observer failures, output equality, and that the workload really
   was the same one (k, prompt tokens, generated counts, rounds within reason).
   A missing artifact is a REJECT, not a pass.

Reports per-pair deltas and the sign count as well as the median: three pairs
leaning the same way is different evidence from three pairs averaging the same
way, and at this n the sign is the more honest statistic.
"""
import re, sys, json, os, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

B = os.path.dirname(os.path.abspath(__file__))

from validate import validate

def arm(label, ref=None):
    """Return (tok_s, workload) or (None, reason). The whole check is validate.py's."""
    ok, info = validate(label)
    if not ok: return None, info
    tok, w = info
    if ref and w != ref: return None, f"workload differs {w} vs {ref}"
    return tok, w

def main(a_pat, b_pat, reps):
    ref = None
    pairs, dropped = [], []
    for r in reps:
        la, lb = f"{a_pat}-{r}", f"{b_pat}-{r}"
        va, ia = arm(la, ref)
        if va is not None and ref is None: ref = ia
        va, ia = arm(la, ref)
        vb, ib = arm(lb, ref)
        if va is None or vb is None:
            why = []
            if va is None: why.append(f"{la}: {ia}")
            if vb is None: why.append(f"{lb}: {ib}")
            dropped.append("; ".join(why)); continue
        pairs.append((r, va, vb))
    print(f"pairs used = {len(pairs)}")
    for d in dropped: print(f"  DROPPED PAIR -- {d}")
    if ref: print(f"  workload verified identical across arms: k={ref[0]} prompt={ref[1]} gen={ref[2]}/{ref[3]} offloaded={ref[4]}")
    if len(pairs) < 3:
        print(f"  n={len(pairs)} is below the 3 I hold myself to; reporting, not concluding.")
    if not pairs: return 1
    print(f"\n{'pair':>5} {a_pat:>10} {b_pat:>10} {'delta':>8} {'%':>7}")
    ds = []
    for r, va, vb in pairs:
        d = vb - va; ds.append(d)
        print(f"{r:>5} {va:10.2f} {vb:10.2f} {d:+8.2f} {100*d/va:+6.1f}%")
    pos = sum(1 for d in ds if d > 0)
    print(f"\n  {b_pat} faster in {pos} of {len(ds)} pairs; mean {sum(ds)/len(ds):+.2f} tok/s, "
          f"range {min(ds):+.2f} to {max(ds):+.2f}")
    if pos and pos != len(ds):
        print("  MIXED SIGNS: no effect established, whatever the mean says.")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2], sys.argv[3:] or ["1","2","3","4","5"]))
