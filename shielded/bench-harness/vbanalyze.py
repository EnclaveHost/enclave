#!/usr/bin/env python3
"""Decompose the run-to-run verify spread across a batch of identical runs.

Per run: the bench's verify ms/round (json); from [schedprof], the verify
graphs' (642 splits, rows=2) mean wall split into CPU splits and shielded
splits; from the [ph] phase trace (card 0's cumulative counters over the spec
decode window, per round), wire / split gemm / helper gemm / join / mask /
unmask / rhs / idle. Then, across runs, the change in each component per ms of
verify change (least-squares slope) and its correlation, so the component that
MOVES with verify is named, not assumed.

  vbanalyze.py LABEL...
"""
import re, sys, json, statistics as st

SP = re.compile(r"\[schedprof\] splits=(\d+) rows=(-?\d+) alloc=([\d.]+)\((\d+)\) total=([\d.]+) copy=([\d.]+) cpu=([\d.]+)\((\d+)\) other=([\d.]+)\((\d+)\) loop=([\d.]+)")
F = "idle link graph mask unmask rhs check pads wire pre sgemm spost sjoin hgemm hpost mkern dwait".split()
PH = re.compile(r'\[ph\] card=(\d+) t=([\d.]+) m=(\d+) graphs=(\d+) nodes=(\d+) ex=(\d+) ' + ' '.join(f'{f}=([\\d.]+)' for f in F))

def one(L):
    d = json.loads(open(L + '.json').read().strip().splitlines()[-1])
    ver = []
    recs = []
    for line in open(L + '.err', errors='replace'):
        m = SP.search(line)
        if m and int(m[1]) == 642 and int(m[2]) == 2:
            ver.append((float(m[5]), float(m[7]), float(m[9])))
        m = PH.match(line)
        if m and int(m[1]) == 0:
            recs.append(dict(t=float(m[2]), m=int(m[3]), **{f: float(m[7 + i]) for i, f in enumerate(F)}))
    out = dict(spec=d['decode_tok_s'], verify=d['verify_ms_per_round'], plain=d['plain_ms_per_tok'],
               sched_total=st.mean(v[0] for v in ver), sched_cpu=st.mean(v[1] for v in ver), sched_shd=st.mean(v[2] for v in ver))
    cut = 0
    for i in range(1, len(recs)):
        if recs[i]['t'] - recs[i - 1]['t'] > 1.0: cut = i
    seg = recs[cut:]
    idx = [i for i, r in enumerate(seg) if r['m'] == 2]
    a, b = seg[idx[0]], seg[idx[-1]]
    n = d['rounds'] - 1
    for f in ('wire', 'sgemm', 'hgemm', 'sjoin', 'mask', 'unmask', 'rhs', 'idle', 'spost', 'hpost', 'mkern'):
        out[f] = (b[f] - a[f]) / n
    return out

def slope(xs, ys):
    mx, my = st.mean(xs), st.mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    syy = sum((y - my) ** 2 for y in ys)
    return (sxy / sxx if sxx else 0.0), (sxy / (sxx * syy) ** 0.5 if sxx and syy else 0.0)

runs = {L: one(L) for L in sys.argv[1:]}
keys = ['spec', 'verify', 'sched_total', 'sched_cpu', 'sched_shd', 'wire', 'sgemm', 'hgemm', 'sjoin', 'mask', 'unmask', 'rhs', 'spost', 'hpost', 'mkern', 'idle', 'plain']
print('run      ' + ' '.join(f'{k[:8]:>8s}' for k in keys))
for L, r in runs.items():
    print(f'{L:8s} ' + ' '.join(f'{r[k]:8.2f}' for k in keys))
vs = [r['verify'] for r in runs.values()]
print(f'\nverify range {min(vs):.2f}-{max(vs):.2f} ms; per ms of verify, each component moves by (slope, r):')
for k in keys[2:]:
    s, c = slope(vs, [r[k] for r in runs.values()])
    print(f'  {k:12s} {s:+6.3f}  r={c:+.2f}')
