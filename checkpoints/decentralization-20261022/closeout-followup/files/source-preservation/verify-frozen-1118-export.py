"""Prove the frozen-1118 patches reproduce every recorded tree, offline, from PUSHED checkpoint material (f2db53ff), in throwaway
bare repos with a temporary index ("1118" = the batch start 2026-10-23T11:18Z, an identifier):
* 4106c311 (tls-m)              = frozen-0830's f-final recipe (0757085e chain + the stored merge diff)
* bcd3d9ca (s-compose)          = empty + frozen-0630 s-holder + frozen-0745 s-holder-final + frozen-0830 s-root-doc
* f8351487's DERIVATIVE (p-compose) = empty + frozen-0931 p-l1 patches
* ca818b75's DERIVATIVE (e-final)   = empty + frozen-0830 e-derivative + frozen-0931 e-closure patches
* the rest: root commits from the empty tree. p-compose and e-final reproduce DERIVATIVE trees only.
Writes source-preservation/frozen-1118-export/REPRODUCE-CHECK.txt."""
from pathlib import Path
import json, os, subprocess, tempfile
root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = 'f2db53ff5691fa691760ce2a102126291a1354f6'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-1118-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
report = []
def stored(rel): return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout
J = lambda rel: json.loads(stored(rel))
X = lambda n: f'source-preservation/frozen-{n}-export/'
f410, f630, f745, f830, f931 = (J(X(n) + 'INVENTORY.json') for n in ('0410', '0630', '0745', '0830', '0931'))
ncodec = J('rpc-native-codec-export/INVENTORY.json')
P = lambda prefix, side: [prefix + p['file'] for p in side['patches']]
F_CHAIN = (P('rpc-native-codec-export/', ncodec['sides']['c']) + P(X('0410'), f410['sides']['c-host-services-cold'])
           + P(X('0630'), f630['sides']['c-carriers']) + P(X('0830'), f830['merge']))
S_CHAIN = P(X('0630'), f630['sides']['s-holder']) + P(X('0745'), f745['sides']['s-holder-final']) + P(X('0830'), f830['sides']['s-root-doc'])
s, d = inv['sides'], inv['derivatives']
BASES = {'tls-m': (ncodec['sides']['c']['base'], F_CHAIN, f830['merge']['headTree']),
         's-compose': (None, S_CHAIN, f830['sides']['s-root-doc']['headTree']),
         'p-compose': (None, P(X('0931'), f931['derivatives']['p-l1']), f931['derivatives']['p-l1']['headTree']),
         'e-final': (None, P(X('0830'), f830['derivative']) + P(X('0931'), f931['derivatives']['e-closure']), f931['derivatives']['e-closure']['headTree'])}
for k in s:
    BASES.setdefault(k, (None, [], EMPTY))
assert f830['merge']['commit']['commit'] == s['tls-m']['base'] and f830['sides']['s-root-doc']['head'] == s['s-compose']['base']
assert f931['derivatives']['p-l1']['head'] == d['p-compose']['base'] and f931['derivatives']['e-closure']['head'] == d['e-final']['base']
def check(name, side):
    start, steps, want = BASES[name]
    with tempfile.TemporaryDirectory(prefix='frozen-1118-verify-') as tmp:
        tmp = Path(tmp)
        env = {**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index'), 'GIT_CONFIG_NOSYSTEM': '1'}
        run = lambda *a, **kw: subprocess.run(['git', '-c', 'gc.auto=0', *a], env=env, cwd=tmp, check=True, capture_output=True, **kw)
        run('init', '-q', '--bare', str(tmp / 'r.git')); (tmp / 'r.git/objects/info/alternates').write_text(f'{checkpoint}/.git/objects\n')
        run('read-tree', start) if start else run('read-tree', '--empty')
        for i, what in enumerate(steps):
            pf = tmp / f'prior-{i}.patch'; pf.write_bytes(stored(what)); run('apply', '--cached', '--whitespace=nowarn', str(pf))
        tree = run('write-tree').stdout.decode().strip(); ok = tree == want
        report.append(f"{name} base rebuilt from {(start or 'empty')[:9]} + {len(steps)} stored patch(es) in {CK[:9]}: tree {tree} {'OK' if ok else 'MISMATCH want ' + want}")
        patches = iter(side['patches'])
        for commit in side['commits']:
            if commit.get('emptyAfterExclusion'):     # touches only excluded paths: no patch; the derived tree must not change
                good = tree == commit['tree']; ok &= good
                report.append(f"{name} {commit['commit'][:9]}: excluded-paths-only commit, derived tree {tree} {'unchanged OK' if good else 'MISMATCH want ' + commit['tree']}")
                continue
            run('apply', '--cached', '--whitespace=nowarn', str(out / next(patches)['file']))
            tree = run('write-tree').stdout.decode().strip(); good = tree == commit['tree']; ok &= good
            report.append(f"{name} {commit['commit'][:9]}: tree {tree} {'OK' if good else 'MISMATCH want ' + commit['tree']}")
        assert next(patches, None) is None, f'{name}: unused patches'
        return ok and tree == side['headTree']
results = {k: check(k, v) for k, v in {**s, **d}.items()}
for k in d:
    report.append(f'{k} trees are the ORIGINAL trees minus {d[k]["excluded"]} (head original {d[k]["originalHeadTree"][:9]}); exact originals NOT reproduced')
report.append('RESULT ' + ', '.join(f'{k} reproduced: {v}' for k, v in results.items()))
(out / 'REPRODUCE-CHECK.txt').write_text('\n'.join(report) + '\n'); print('\n'.join(report))
raise SystemExit(0 if all(results.values()) else 1)
