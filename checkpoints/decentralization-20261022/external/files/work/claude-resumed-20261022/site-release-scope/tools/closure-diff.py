#!/usr/bin/env python3
"""closure-diff.py -> out/closure.tsv + out/closure-summary.json   (READ-ONLY: git ls-tree / hash-object without -w; no writes
outside this package; GIT_OPTIONAL_LOCKS=0)

Every input of the public site build (scripts/build-site.mjs: site/**, its scripts, contracts/*.sol compiled by
build-contract-artifacts.mjs, the network/ modules site code imports, THIRD-PARTY-NOTICES.md, package*.json) plus the release
tool (scripts/site-release/**) and the two branding docs, as git blob ids in six sources:
  LIVE  c2bc3cc6   work/enclave commit the live ENS release bafybeieuxt6 was built from (footer stamp)
  MAIN  7752a4239  published main (reconciliation/upstream.git)
  E762  e762a9c5   work/enclave HEAD (local, pre-rewrite; dirty working tree NOT used)
  REC   site-host-recovery-release/tree (frozen reviewed: e762 snapshot + uncommitted integrations + deployments.js:1732)
  CAND0 cf00054a   the reconciled candidate's recorded git tree (upstream.git)
  CAND  resume-20261021/reconciled-candidate directory now
Generated build outputs (site/css/site.css, site/js/gen/contract-artifacts.js, contracts/*.abi.json, site/dist) are excluded."""
import json, os, subprocess, sys, hashlib
W = '/home/steven/Documents/Codex/2026-10-18/wo/work'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'out')
ENV = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}
UP = f'{W}/resume-20261021/reconciliation/upstream.git'
GITS = {'LIVE': (f'--git-dir={W}/enclave/.git', 'c2bc3cc6'), 'MAIN': (f'--git-dir={UP}', '7752a4239'),
        'E762': (f'--git-dir={W}/enclave/.git', 'e762a9c5'), 'CAND0': (f'--git-dir={UP}', 'cf00054aa76ddabf97af0c955d89d79bfa4caeab')}
DIRS = {'REC': f'{W}/site-host-recovery-release/tree', 'CAND': f'{W}/resume-20261021/reconciled-candidate'}
ORDER = ['LIVE', 'MAIN', 'E762', 'REC', 'CAND0', 'CAND']
EXACT = {'scripts/build-site.mjs', 'scripts/site-built-in-profile.mjs', 'scripts/build-contract-artifacts.mjs', 'THIRD-PARTY-NOTICES.md',
         'package.json', 'package-lock.json', 'PRODUCT.md', 'README.md', 'network/host-liveness.mjs', 'network/host-policy-mirrors.mjs',
         'network/network-policy-core.mjs', 'network/canonical.mjs', 'network/wg-config.mjs'}
GENERATED = {'site/css/site.css', 'site/js/gen/contract-artifacts.js'}
def inscope(p):
    if p in GENERATED or p.startswith(('site/dist/', 'site/node_modules/')) or '/node_modules/' in p: return False
    if p in EXACT or p.startswith(('site/', 'scripts/site-release/')): return True
    return p.startswith('contracts/') and p.endswith('.sol')
def git_tree(spec):
    gd, rev = spec
    r = subprocess.run(['git', gd, 'ls-tree', '-r', '--full-tree', rev], capture_output=True, text=True, env=ENV, check=True)
    out = {}
    for line in r.stdout.splitlines():
        meta, path = line.split('\t', 1); mode, typ, blob = meta.split()
        if typ == 'blob' and inscope(path): out[path] = ('L:' if mode == '120000' else '') + blob
    return out
def git_blob(data): return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()
def dir_tree(root):
    out = {}
    for d, ds, fs in os.walk(root):
        ds[:] = [x for x in ds if x not in ('node_modules', '.git')]
        for f in fs:
            p = os.path.join(d, f); rel = os.path.relpath(p, root)
            if not inscope(rel): continue
            out[rel] = 'L:' + git_blob(os.readlink(p).encode()) if os.path.islink(p) else git_blob(open(p, 'rb').read())
    return out
T = {k: git_tree(v) for k, v in GITS.items()}
T.update({k: dir_tree(v) for k, v in DIRS.items()})
paths = sorted(set().union(*[set(t) for t in T.values()]))
rows, summary = [], {}
def cls(p):
    if p.startswith('site/'): return 'site'
    if p.startswith('scripts/site-release/'): return 'release-tool'
    if p.startswith('contracts/'): return 'contracts'
    if p.startswith('network/'): return 'network'
    if p in ('PRODUCT.md', 'README.md'): return 'docs-not-built'
    return 'build'
with open(os.path.join(OUT, 'closure.tsv'), 'w') as f:
    f.write('path\tclass\t' + '\t'.join(ORDER) + '\n')
    for p in paths:
        v = [T[k].get(p, '-') for k in ORDER]
        f.write(f'{p}\t{cls(p)}\t' + '\t'.join(x[:12] for x in v) + '\n'); rows.append((p, cls(p), dict(zip(ORDER, v))))
def delta(a, b, c=None):
    ch = [(p, k) for p, k, v in rows if v[a] != v[b] and (c is None or k == c)]
    return ch
pairs = [('LIVE', 'MAIN'), ('MAIN', 'CAND'), ('MAIN', 'REC'), ('REC', 'CAND'), ('CAND0', 'CAND'), ('E762', 'REC'), ('LIVE', 'E762')]
for a, b in pairs:
    d = delta(a, b)
    by = {}
    for p, k in d: by.setdefault(k, []).append(p)
    summary[f'{a}->{b}'] = {k: {'count': len(v), 'paths': v if len(v) <= 400 else v[:400] + ['...']} for k, v in sorted(by.items())}
json.dump({'sources': {**{k: f'{v[0]} {v[1]}' for k, v in GITS.items()}, **DIRS}, 'pathsInScope': len(paths), 'deltas': summary}, open(os.path.join(OUT, 'closure-summary.json'), 'w'), indent=1)
for a, b in pairs:
    print(f'{a}->{b}:', {k: v['count'] for k, v in summary[f"{a}->{b}"].items()})
