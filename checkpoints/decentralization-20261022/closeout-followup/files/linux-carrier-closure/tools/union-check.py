#!/usr/bin/env python3
"""union-check.py REPO COMPOSED OUT.json  (Git objects only; read-only)

The composed head must be the exact union of its inputs:
  OURS  = fec43a6a + carriers/harness/test commits  (493ee9ee .. OURS_HEAD)
  ADMIN = 493ee9ee .. dfe020abf (root's admin-CLI commits)          A = dfe020abf .. 71448f63
  B     = 921d60c2 .. 8d110101                                       ROOT = 2efc4a83 .. fd6a1762
For every path in COMPOSED: its blob equals the one side that changed it, or the base's; a path changed by more than one side
must be the exact line union (each side's +/- lines appear exactly once, nothing else changed). ROOT-REVIEW*.md is checked
separately (1086cf23's at its path, fd6a1762's renamed byte-for-byte)."""
import json, subprocess, sys, difflib

repo, composed, out = sys.argv[1:4]
N493, DFE, A, B0, B, R0, R = ('493ee9ee07497c94159ec4f6916e9ea920d31959', 'dfe020abf1794bedc42943e43fe85eb02593dd8d',
                              '71448f63ba189b1f61153e7df766f9421b350205', '921d60c2b37ec8ae64e1fd22d7bc7b408939bd70',
                              '8d110101f6cdd5a03ffa16f52e6afb1ea8c6f346', '2efc4a83ec6636f875fa4523d50674bda06bcdcb',
                              'fd6a1762ed1218d5d32fb43df2ccb97caa2b17e4')
g = lambda *a: subprocess.check_output(['git', '-C', repo, *a], text=True)
ours = g('rev-list', '-1', '--grep=refuse the four former fleet mirrors explicitly', composed).strip()   # last commit of OURS
assert ours, 'OURS head not found'
def changed(a, b): return set(g('diff', '--name-only', '--no-renames', a, b).split())
def blob(c, p):
    r = subprocess.run(['git', '-C', repo, 'rev-parse', '-q', '--verify', f'{c}:{p}'], capture_output=True, text=True)
    return r.stdout.strip() or None
def text(c, p):
    r = subprocess.run(['git', '-C', repo, 'show', f'{c}:{p}'], capture_output=True)
    return r.stdout.decode('utf-8', 'replace').splitlines() if r.returncode == 0 else []
sides = {'ours': (N493, ours), 'admin': (N493, DFE), 'A': (DFE, A), 'B': (B0, B), 'ROOT': (R0, R)}
ch = {k: changed(a, b) for k, (a, b) in sides.items()}
paths = set().union(*ch.values()) | changed(N493, composed)
special = {'ROOT-REVIEW.md', 'ROOT-REVIEW-verified-snapshot-lifecycle.md'}
res = {'composed': composed, 'oursHead': ours, 'single': 0, 'multi': {}, 'bad': [], 'unexpected': []}
def body(a, b):
    return [l for l in difflib.unified_diff(a, b, lineterm='', n=0) if l[:1] in '+-' and not l.startswith(('+++', '---'))]
for p in sorted(paths - special):
    who = [k for k in sides if p in ch[k]]
    got = blob(composed, p)
    if not who:
        res['unexpected'].append(p); continue
    if len(who) == 1:
        a, b = sides[who[0]]
        # B and ROOT sit on A's history: their base blob must equal what the composed tree had before them
        if got != blob(b, p): res['bad'].append({'path': p, 'side': who[0], 'want': blob(b, p), 'got': got})
        else: res['single'] += 1
        continue
    # several sides changed it: every side's own +/- lines, and nothing else
    if set(who) <= {'A', 'B', 'ROOT'} and len(who) > 1:
        # stacked on one history (921d60c2 and 2efc4a83 are A's own commits): the last side's blob must be the result
        last = [s for s in ('A', 'B', 'ROOT') if s in who]
        ok = got in {blob(sides[s][1], p) for s in last}
        res['multi'][p] = {'sides': who, 'stacked': True, 'ok': ok}
        if not ok: res['bad'].append({'path': p, 'sides': who})
        continue
    comp = text(composed, p); base = text(N493, p)
    want = sorted(l for s in who for l in body(text(sides[s][0], p), text(sides[s][1], p)))
    have = sorted(body(base, comp))
    ok = want == have
    res['multi'][p] = {'sides': who, 'lines': len(have), 'ok': ok}
    if not ok: res['bad'].append({'path': p, 'sides': who, 'missing': [l for l in want if l not in have][:5], 'extra': [l for l in have if l not in want][:5]})
# fec43a6a's ROOT-REVIEW.md IS ROOT 1086cf23's bytes (asserted by linux-runtime-release/tools/s1-compose.sh; 1086cf23's own
# commit object is not in this repository)
res['rootReviews'] = {'ROOT-REVIEW.md == fec43a6a (= ROOT 1086cf23)': blob(composed, 'ROOT-REVIEW.md') == blob('fec43a6a08da2ac287fb3a5c42de89f096f4f678', 'ROOT-REVIEW.md'),
                      'renamed == fd6a1762 ROOT-REVIEW.md': blob(composed, 'ROOT-REVIEW-verified-snapshot-lifecycle.md') == blob(R, 'ROOT-REVIEW.md')}
res['ok'] = not res['bad'] and not res['unexpected'] and all(res['rootReviews'].values())
json.dump(res, open(out, 'w'), indent=1, sort_keys=True)
print(json.dumps({k: v for k, v in res.items() if k != 'multi'}, indent=1)); print(json.dumps(res['multi'], indent=1))
sys.exit(0 if res['ok'] else 6)
