"""Prove the frozen-1726 patches reproduce every recorded tree, offline, from PUSHED checkpoint material (1219a988) plus this batch's
own earlier patches, in throwaway bare repos with a temporary index ("1726" = the batch start 2026-10-23T17:26Z, an identifier).
node-shares' base d281007c is rebuilt from the pushed rpc-native-codec-export side c (its base f58e03ec + its first 6 patches);
cpu-enforce continues node-shares' first commit (0f1ef848) and cpu-oldguest continues cpu-enforce's first commit (670a753e).
Writes source-preservation/frozen-1726-export/REPRODUCE-CHECK.txt."""
from pathlib import Path
import json, os, subprocess, tempfile
root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = '1219a9882904b73349aee9582a9e35b355c03e26'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-1726-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
report = []
def stored(rel): return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout
J = lambda rel: json.loads(stored(rel))
ncodec = J('rpc-native-codec-export/INVENTORY.json')
P = lambda prefix, side: [prefix + p['file'] for p in side['patches']]
LOCAL = 'LOCAL:'   # a patch of THIS export (not yet pushed), applied after the pushed chain
L = lambda side: [LOCAL + p['file'] for p in side['patches']]
s = inv['sides']; nc = ncodec['sides']['c']; F0 = nc['base']
assert nc['commits'][5]['commit'] == s['node-shares']['base'] and not any(c.get('emptyAfterExclusion') for c in nc['commits'][:6])
NODE0 = P('rpc-native-codec-export/', nc)[:6]
BASES = {'node-shares': (F0, NODE0, nc['commits'][5]['tree']),
         'cpu-enforce': (F0, NODE0 + L(s['node-shares'])[:1], s['node-shares']['commits'][0]['tree']),
         'cpu-oldguest': (F0, NODE0 + L(s['node-shares'])[:1] + L(s['cpu-enforce'])[:1], s['cpu-enforce']['commits'][0]['tree'])}
for k in s:
    BASES.setdefault(k, (None, [], EMPTY))
assert s['node-shares']['commits'][0]['commit'] == s['cpu-enforce']['base'] and s['cpu-enforce']['commits'][0]['commit'] == s['cpu-oldguest']['base']
def check(name, side):
    start, steps, want = BASES[name]
    with tempfile.TemporaryDirectory(prefix='frozen-1726-verify-') as tmp:
        tmp = Path(tmp)
        env = {**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index'), 'GIT_CONFIG_NOSYSTEM': '1'}
        run = lambda *a, **kw: subprocess.run(['git', '-c', 'gc.auto=0', *a], env=env, cwd=tmp, check=True, capture_output=True, **kw)
        run('init', '-q', '--bare', str(tmp / 'r.git')); (tmp / 'r.git/objects/info/alternates').write_text(f'{checkpoint}/.git/objects\n')
        run('read-tree', start) if start else run('read-tree', '--empty')
        for i, what in enumerate(steps):
            pf = tmp / f'prior-{i}.patch'
            pf.write_bytes((out / what[len(LOCAL):]).read_bytes() if what.startswith(LOCAL) else stored(what))
            run('apply', '--cached', '--whitespace=nowarn', str(pf))
        tree = run('write-tree').stdout.decode().strip(); ok = tree == want
        npushed = sum(not w.startswith(LOCAL) for w in steps)
        report.append(f"{name} base rebuilt from {(start or 'empty')[:9]} + {npushed} stored patch(es) in {CK[:9]} + {len(steps) - npushed} "
                      f"patch(es) of this export: tree {tree} {'OK' if ok else 'MISMATCH want ' + want}")
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
