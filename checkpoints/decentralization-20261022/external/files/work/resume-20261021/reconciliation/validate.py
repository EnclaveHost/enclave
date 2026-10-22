#!/usr/bin/env python3
"""Independent validation of reconciled-candidate (reads work/enclave, upstream.git and the candidate; writes validation.json).
 1. every local path (minus explicit exclusions): candidate bytes == T(local bytes), same mode/symlink-ness, deletions absent
 2. upstream's corrections preserved: PRODUCT.md and site/js/pages/sso-authorize.js == 7752a423 bytes; README.md carries every
    upstream hunk AND every local hunk (candidate-vs-upstream diff == local change; candidate-vs-T(local) diff == upstream change)
 3. brand-transform impact: the T-affected local files, and every path named by the two published main-impact records, with
    its candidate status; JS/MJS among them pass `node --check` (syntax only - NOT a test result)
 4. secret-pattern scan of every changed candidate file: pattern NAMES and line counts only, never values
"""
import difflib, hashlib, json, os, re, stat, subprocess, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent; W = HERE.parents[1]; M = W/'enclave'; C = HERE.parent/'reconciled-candidate'; UG = HERE/'upstream.git'
O = W.parent/'outputs'; UHEAD = '7752a4239b3bec2cf452491cd1b95164a8c2bdb8'; LBASE = 'c2bc3cc636ce53719f52688093ea892b9c8639c1'
ENV = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}
T = lambda b: b.replace(b'Cloud Provider', b'Cloud Provider').replace(b'Cloud Provider', b'Cloud Provider')
show = lambda rev, p: subprocess.run(['git', '--git-dir', str(UG), 'show', f'{rev}:{p}'], capture_output=True, check=True, env=ENV).stdout
def state(root, p):
    fp = root/p
    try: s = os.lstat(fp)
    except FileNotFoundError: return None
    if stat.S_ISLNK(s.st_mode): return ('link', os.readlink(fp).encode())
    return ('x' if s.st_mode & 0o111 else 'f', fp.read_bytes())
inv = json.load(open(HERE/'candidate-inventory.json')); pinv = json.load(open(HERE/'path-inventory.json'))
excluded = {e['path'] for e in inv['excluded']}
out = {'candidateTree': inv['candidateTree']}
# 1
bad, n, links, execs, dels = [], 0, 0, 0, 0
for p, r in pinv['paths'].items():
    if not (r['committed'] or r['working']) or p in excluded: continue
    n += 1; l, c = state(M, p), state(C, p)
    if p == 'README.md': continue   # merged; checked in 2
    want = (l[0], T(l[1])) if l else None
    if want != c: bad.append(p)
    links += bool(c and c[0] == 'link'); execs += bool(c and c[0] == 'x'); dels += c is None
for p in excluded:   # excluded paths are local-only additions: they must be absent from the candidate
    if state(C, p) is not None: bad.append('EXCLUDED-PRESENT ' + p)
out['localPathsChecked'] = n; out['symlinks'] = links; out['executables'] = execs; out['deletions'] = dels; out['mismatches'] = bad
print('LOCAL-PATHS', n, 'candidate == T(local) mismatches', len(bad), '| symlinks', links, 'executables', execs, 'deletions', dels)
# 2
for p in ['PRODUCT.md', 'site/js/pages/sso-authorize.js']:
    ok = state(C, p)[1] == show(UHEAD, p); out[p] = ok; print('UPSTREAM-PRESERVED' if ok else 'UPSTREAM-LOST', p)
base = T(subprocess.run(['git', '-C', str(M), 'show', f'{LBASE}:README.md'], capture_output=True, check=True, env=ENV).stdout).decode().splitlines()
local = T((M/'README.md').read_bytes()).decode().splitlines(); up = show(UHEAD, 'README.md').decode().splitlines(); cand = (C/'README.md').read_text().splitlines()
def changes(a, b): return [(t, a[i1:i2], b[j1:j2]) for t, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes() if t != 'equal']
readme_ok = changes(up, cand) == changes(base, local) and changes(local, cand) == changes(base, up)
out['README.md'] = readme_ok
print('README-MERGE carries every upstream hunk and every local hunk:', readme_ok, '| upstream hunks', len(changes(base, up)), 'local hunks', len(changes(base, local)))
# 3
impact = {}
for rec in ['Cloud Provider-text-cleanup-20261021', 'Cloud Provider-lowercase-cleanup-20261021']:
    for p in json.load(open(O/rec/'main-impact.json'))['paths']: impact.setdefault(p, []).append(rec)
taff = {e['path'] for e in inv['brandTransformAffectedLocalFiles']}
rows = []
for p in sorted(set(impact) | taff):
    r = pinv['paths'].get(p, {}); c = state(C, p)
    row = {'path': p, 'publishedImpactRecords': impact.get(p, []), 'localChange': bool(r.get('committed') or r.get('working')),
           'transformAppliedToLocalChange': p in taff, 'remainingLiteral': bool(c and (b'Cloud Provider' in c[1] or b'Cloud Provider' in c[1]))}
    if c and p.endswith(('.js', '.mjs', '.cjs')) and c[0] != 'link':
        rc = subprocess.run(['node', '--check', str(C/p)], capture_output=True, text=True)
        row['nodeCheck'] = 'ok' if rc.returncode == 0 else rc.stderr.strip().splitlines()[-1][:200]
    rows.append(row)
out['brandImpact'] = rows
for r in rows: print('BRAND', 'T-applied' if r['transformAppliedToLocalChange'] else ('local' if r['localChange'] else 'upstream-only'), r.get('nodeCheck', '-'), ','.join(x.split('-')[1] for x in r['publishedImpactRecords']) or 'new', r['path'])
grepall = subprocess.run(['grep', '-rIl', '-e', 'Cloud Provider', '-e', 'Cloud Provider', str(C)], capture_output=True, text=True).stdout.split()
out['literalRemainingAnywhere'] = [os.path.relpath(x, C) for x in grepall]; print('LITERAL-REMAINING-IN-CANDIDATE', len(grepall))
# 4
PAT = {'pem-private-key': rb'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----', 'hex-private-key-assignment': rb'(?i)(?:private[_-]?key|privkey|secret[_-]?key|PRIVATE_KEY)["\']?\s*[:=]\s*["\']?(?:0x)?[0-9a-f]{64}\b',
       'bip39-like-mnemonic-assignment': rb'(?i)mnemonic["\']?\s*[:=]\s*["\'](?:[a-z]+ ){11,23}[a-z]+["\']', 'aws-access-key': rb'AKIA[0-9A-Z]{16}',
       'github-token': rb'gh[pousr]_[A-Za-z0-9]{36}', 'slack-token': rb'xox[baprs]-[A-Za-z0-9-]{10,}', 'cloudflare-or-generic-bearer': rb'(?i)authorization:\s*bearer\s+[A-Za-z0-9._-]{30,}'}
ANVIL = [b'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', b'59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
         b'5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', b'7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6']
hits = []
for row in inv['changedPaths']:
    p = row['path']; c = state(C, p)
    if not c or c[0] == 'link': continue
    for name, rx in PAT.items():
        ms = list(re.finditer(rx, c[1]))
        if ms:
            known = sum(any(k in m.group(0).lower() for k in ANVIL) for m in ms)
            hits.append({'path': p, 'pattern': name, 'count': len(ms), 'wellKnownAnvilTestKeys': known})
out['secretPatternHits'] = hits
for h in hits: print('SECRET-PATTERN', h['pattern'], h['count'], 'anvil-test-keys', h['wellKnownAnvilTestKeys'], h['path'])
json.dump(out, open(HERE/'validation.json', 'w'), indent=1)
ok = not bad and out['PRODUCT.md'] and out['site/js/pages/sso-authorize.js'] and readme_ok and not grepall
print('VALIDATION-' + ('OK' if ok else 'FAILED')); sys.exit(0 if ok else 1)
