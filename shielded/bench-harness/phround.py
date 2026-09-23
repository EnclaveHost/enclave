#!/usr/bin/env python3
"""Per-round phase budget of the speculative decode window, from the
cumulative [ph] records: difference each counter between the first and last
m=2 (verify) record of the LAST segment, per card, divided by the rounds.
Cards run concurrently: their figures are side by side, never summed."""
import re, sys, json
L = sys.argv[1]
F = "idle link graph mask unmask rhs check pads wire pre sgemm spost sjoin hgemm hpost mkern dwait".split()
R = re.compile(r'\[ph\] card=(\d+) t=([\d.]+) m=(\d+) graphs=(\d+) nodes=(\d+) ex=(\d+) ' + ' '.join(f'{f}=([\\d.]+)' for f in F))
recs = {0: [], 1: []}
for line in open(L + '.err', errors='replace'):
    m = R.match(line)
    if m:
        c = int(m[1]); recs.setdefault(c, []).append(dict(t=float(m[2]), m=int(m[3]), graphs=int(m[4]), ex=int(m[6]),
                                                      **{f: float(m[7 + i]) for i, f in enumerate(F)}))
j = json.loads(open(L + '.json').read().strip().splitlines()[-1])
rounds = j['rounds']
print(f"{L}: spec {j['decode_tok_s']} tok/s, {rounds} rounds, verify {j['verify_ms_per_round']} + draft {j['draft_ms_per_round']} ms/round")
for c, rs in sorted(recs.items()):
    if not rs: continue
    # last segment = after the last big wall gap
    cut = 0
    for i in range(1, len(rs)):
        if rs[i]['t'] - rs[i - 1]['t'] > 1.0: cut = i
    seg = rs[cut:]
    idx = [i for i, r in enumerate(seg) if r['m'] == 2]
    a, b = seg[idx[0]], seg[idx[-1]]
    wall = (b['t'] - a['t']) * 1000
    n = rounds - 1   # records between first and last verify graph span rounds-1 rounds (approx.)
    print(f" card {c}: window {wall:.0f} ms, graphs {b['graphs'] - a['graphs']}, exchanges {b['ex'] - a['ex']}; per round (/{n}):")
    print("   " + "  ".join(f"{f}={(b[f] - a[f]) / n:.2f}" for f in F))
