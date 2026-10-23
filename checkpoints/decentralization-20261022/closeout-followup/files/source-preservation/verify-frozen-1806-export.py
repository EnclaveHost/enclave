"""Prove the frozen-1806 patches reproduce every recorded tree, offline, from PUSHED checkpoint material (6dcde703), in throwaway bare
repos with a temporary index ("1806" = the batch start 2026-10-23T18:06Z, an identifier). root-cpu-build's base c516049c is rebuilt
from the pushed frozen-1726 root-cpu-canary patch; custody-audit starts from the empty tree.
Writes source-preservation/frozen-1806-export/REPRODUCE-CHECK.txt."""
from pathlib import Path
import json, os, subprocess, tempfile
root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = '6dcde703004dcb34e702ec2aff8309e48ced44ae'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-1806-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
report = []
def stored(rel): return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout
J = lambda rel: json.loads(stored(rel))
X = lambda n: f'source-preservation/frozen-{n}-export/'
f1726 = J(X('1726') + 'INVENTORY.json')
P = lambda prefix, side: [prefix + p['file'] for p in side['patches']]
s = inv['sides']; rc = f1726['sides']['root-cpu-canary']
assert rc['head'] == s['root-cpu-build']['base']
BASES = {'root-cpu-build': (None, P(X('1726'), rc), rc['headTree'])}
for k in s:
    BASES.setdefault(k, (None, [], EMPTY))
def check(name, side):
    start, steps, want = BASES[name]
    with tempfile.TemporaryDirectory(prefix='frozen-1806-verify-') as tmp:
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
            run('apply', '--cached', '--whitespace=nowarn', str(out / next(patches)['file']))
            tree = run('write-tree').stdout.decode().strip(); good = tree == commit['tree']; ok &= good
            report.append(f"{name} {commit['commit'][:9]}: tree {tree} {'OK' if good else 'MISMATCH want ' + commit['tree']}")
        assert next(patches, None) is None, f'{name}: unused patches'
        return ok and tree == side['headTree']
results = {k: check(k, v) for k, v in s.items()}
report.append('RESULT ' + ', '.join(f'{k} reproduced: {v}' for k, v in results.items()))
(out / 'REPRODUCE-CHECK.txt').write_text('\n'.join(report) + '\n'); print('\n'.join(report))
raise SystemExit(0 if all(results.values()) else 1)
