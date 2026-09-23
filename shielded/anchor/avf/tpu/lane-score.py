#!/usr/bin/env python3
"""lane-score.py <dir> [<dir> ...] -- score contract-set batches with the SAME checker as the qc7 report.

A <dir> is either a lane-quality.sh batch (MANIFEST.tsv: id, label, status, rc, prompt, expect; logs <label>.log) or a
quality-compare.sh batch such as results/qc7 (id, key, tpu, cpu, prompt, expect; logs <id>.<key>.<arm>.log), given as
<dir>:tpu or <dir>:cpu. Every batch is scored against its OWN manifest's contracts, and when several are given they must
ask the same prompts with the same contracts row for row, or it refuses (the defect three-lane-report.py was fixed for).

The denominator is expect_rows; a failed or missing row is a FAIL with its reason. Per batch it reports PASS count,
decode rate (median of per-row decode_tok_s, and the token-weighted rate sum(tokens)/sum(seconds)), the longest decode,
how many rows hit the token cap, and the kernel-verification totals (disagreements and the worst one in digit LSB).
"""
import os, re, statistics, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'host'))
from quality_checks import PASS, check  # noqa: E402


def load(spec):
    d, arm = (spec.split(':', 1) + [None])[:2]
    lines = open(os.path.join(d, 'MANIFEST.tsv'), errors='replace').read().splitlines()
    expect = next((int(l.split('\t')[1]) for l in lines if l.startswith('# expect_rows')), None)
    if expect is None: sys.exit(f'REFUSING: {d} declares no expect_rows')
    rows = {}
    for l in lines:
        if not l.strip() or l.startswith('#'): continue
        f = l.split('\t')
        if arm:   # quality-compare layout
            idx = {'tpu': 2, 'cpu': 3}[arm]
            rows[f[0]] = dict(prompt=f[4], expect=f[5], ok=f[idx] == 'ok', log=os.path.join(d, f'{f[0]}.{f[1]}.{arm}.log'))
        else:
            rows[f[0]] = dict(prompt=f[4], expect=f[5], ok=f[2] == 'ok', log=os.path.join(d, f'{f[1]}.log'))
    return spec, expect, rows


def score(spec, expect, rows):
    out = {}; toks = secs = 0; rates = []; longest = 0; capped = 0; vbad = 0; vmax = 0; vn = 0
    for i in range(1, expect + 1):
        k = '%02d' % i; r = rows.get(k)
        if r is None: out[k] = ('FAIL', 'missing row'); continue
        txt = open(r['log'], errors='replace').read() if os.path.exists(r['log']) else None
        if not r['ok'] or txt is None: out[k] = ('FAIL', 'run failed' if txt is not None or not r['ok'] else 'no log'); continue
        a = re.findall(r'LOCAL turn \d+ A: (.*)', txt)
        if not a: out[k] = ('FAIL', 'no answer'); continue
        v, why = check(r['expect'], a[0].rstrip()); out[k] = (v, why)
        st = re.search(r'decode_tokens=(\d+), decode_tok_s=([\d.]+)', txt); status = re.search(r'status=(\w+)', txt)
        if st:
            n, rt = int(st.group(1)), float(st.group(2)); longest = max(longest, n)
            if rt > 0: rates.append(rt); toks += n; secs += n / rt
        if status and status.group(1) == 'budget': capped += 1
        vm = re.search(r'verify n=(\d+) bad=(\d+) max=(\d+)', txt)
        if vm: vn += int(vm.group(1)); vbad += int(vm.group(2)); vmax = max(vmax, int(vm.group(3)))
    npass = sum(1 for v in out.values() if v[0] == PASS)
    stats = dict(passed=npass, of=expect, median=statistics.median(rates) if rates else 0, weighted=toks / secs if secs else 0,
                 tokens=toks, longest=longest, capped=capped, ver_n=vn, ver_bad=vbad, ver_max=vmax)
    return out, stats


def main():
    specs = [load(s) for s in sys.argv[1:]]
    if not specs: print(__doc__); return 2
    base = specs[0]
    for s in specs[1:]:
        if s[1] != base[1] or any((s[2].get(k, {}).get('prompt'), s[2].get(k, {}).get('expect')) != (base[2][k]['prompt'], base[2][k]['expect']) for k in base[2]):
            sys.exit(f'REFUSING: {s[0]} does not ask the same prompts with the same contracts as {base[0]}')
    res = [score(*s) for s in specs]
    print('row  ' + '  '.join(f'{os.path.basename(s[0].rstrip("/")):>14}' for s in specs) + '  contract')
    for i in range(1, base[1] + 1):
        k = '%02d' % i
        print(f'{k}   ' + '  '.join(f'{r[0][k][0]:>14}' for r in res) + f'  {base[2][k]["expect"][:60] if k in base[2] else ""}')
    for s, (_, st) in zip(specs, res):
        print(f'{s[0]}: {st["passed"]}/{st["of"]} PASS | decode median {st["median"]:.2f} tok/s, token-weighted {st["weighted"]:.2f} '
              f'over {st["tokens"]} tokens, longest {st["longest"]}, {st["capped"]} at the cap | verify {st["ver_bad"]} of {st["ver_n"]} '
              f'samples disagree, worst {st["ver_max"]} digit LSB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
