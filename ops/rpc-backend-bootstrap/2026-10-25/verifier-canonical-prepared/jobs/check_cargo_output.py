#!/usr/bin/env python3
"""Strict reader of `cargo test` output (verifier-canonical-stage). Exit 0 PASS, 1 FAIL, 3 INCOMPLETE (never a pass).
  named      OUT EXPECTED   exactly the expected binaries, each with exactly its expected test names, all `ok`, and a
                            summary `N passed; 0 failed; 0 ignored; 0 measured; 0 filtered out` with N == expected count
  regression OUT            at least one summary; every summary 0 failed AND 0 ignored AND 0 filtered out
                            (any ignored/filtered test = INCOMPLETE, a failure = FAIL)
  mutant     OUT NAME...    each NAME reported `FAILED` with its own `---- NAME stdout ----` block containing `panicked at`
                            (an assertion), and no compiler error in OUT"""
import re, sys
mode, out = sys.argv[1], open(sys.argv[2], errors='replace').read()
SUM = re.compile(r'^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out', re.M)
def sections():
    """binary name -> its text (from its `Running tests/<bin>.rs` line to the next `Running`/`Doc-tests`)."""
    parts = re.split(r'^\s+(?:Running|Doc-tests)\s+', out, flags=re.M)
    res = {}
    for p in parts[1:]:
        m = re.match(r'tests/(\w+)\.rs', p)
        if m: res.setdefault(m.group(1), []).append(p)
    return res
if mode == 'named':
    exp = {}
    for line in open(sys.argv[3]):
        if line.strip() and not line.startswith('#'):
            b, n = line.split(); exp.setdefault(b, []).append(n)
    secs, bad = sections(), []
    if set(secs) != set(exp): bad.append(f'binaries ran {sorted(secs)} != expected {sorted(exp)}')
    for b, names in exp.items():
        if len(secs.get(b, [])) != 1: bad.append(f'{b}: ran {len(secs.get(b, []))} times'); continue
        t = secs[b][0]
        got = dict(re.findall(r'^test (\S+) \.\.\. (\S+)$', t, re.M))
        if set(got) != set(names): bad.append(f'{b}: names {sorted(set(got) ^ set(names))} differ from expected')
        notok = {n: v for n, v in got.items() if v != 'ok'}
        if notok: bad.append(f'{b}: not ok {notok}')
        s = SUM.search(t)
        if not s: bad.append(f'{b}: no summary'); continue
        st, p, f, i, m, fl = s.group(1), *map(int, s.groups()[1:])
        if (st, p, f, i, m, fl) != ('ok', len(names), 0, 0, 0, 0): bad.append(f'{b}: summary {s.group(0)!r} (expected {len(names)} passed, 0 failed/ignored/measured/filtered)')
    total = sum(len(v) for v in exp.values())
    print(f'named: {total} expected tests in {len(exp)} binaries; ' + ('PASS' if not bad else 'FAIL'))
    for x in bad: print('  [FAIL]', x)
    sys.exit(0 if not bad else 1)
if mode == 'regression':
    sums = SUM.findall(out)
    if not sums: print('regression: no test summary: INCOMPLETE'); sys.exit(3)
    failed = sum(int(s[2]) for s in sums); ignored = sum(int(s[3]) for s in sums); filtered = sum(int(s[5]) for s in sums)
    passed = sum(int(s[1]) for s in sums)
    print(f'regression: {len(sums)} summaries, {passed} passed, {failed} failed, {ignored} ignored, {filtered} filtered out')
    if failed: print('regression: FAIL'); sys.exit(1)
    if ignored or filtered:
        print('regression: INCOMPLETE (ignored or filtered tests are never a pass):')
        for l in re.findall(r'^test (\S+) \.\.\. ignored.*$', out, re.M): print('  ignored:', l)
        sys.exit(3)
    print('regression: PASS'); sys.exit(0)
if mode == 'mutant':
    if re.search(r'^error(\[E\d+\])?:', out, re.M): print('mutant: COMPILER ERROR in run output: INVALID'); sys.exit(3)
    bad = []
    for n in sys.argv[3:]:
        if not re.search(rf'^test {re.escape(n)} \.\.\. FAILED$', out, re.M): bad.append(f'{n}: not FAILED'); continue
        blk = re.search(rf'^---- {re.escape(n)} stdout ----\n(.*?)(?=^---- |\Z|^failures:$)', out, re.M | re.S)
        if not blk or 'panicked at' not in blk.group(1): bad.append(f'{n}: FAILED without its own assertion panic')
    print('mutant: ' + ('KILLED' if not bad else 'NOT KILLED')); [print('  ', x) for x in bad]
    sys.exit(0 if not bad else 1)
sys.exit(2)
