"""Prove the frozen-0830 patches reproduce every recorded tree, offline, from PUSHED checkpoint material (842ca044), in throwaway
bare repos with a temporary index:
* 71448f63 (a-windows)       = the 2efc4a83 recipe (frozen-0420) + frozen-0630 a-native-relay patches
* 47c2f71f (s-root-doc)      = empty + frozen-0630 s-holder + frozen-0745 s-holder-final patches
* 0757085e (f-final merge)   = the 427780bb recipe (frozen-0410) + frozen-0630 c-carriers patch; + the merge diff -> 4106c311's tree
* c-storage-write, e-derivative: root commits from the empty tree. e-derivative reproduces its DERIVATIVE trees only (the
  original trees minus fixtures/artifacts/, computed at export from E's Git objects); the exact original trees are NOT claimed.
Writes source-preservation/frozen-0830-export/REPRODUCE-CHECK.txt."""
from pathlib import Path
import json, os, subprocess, tempfile
root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = '842ca044199b5562136c80b2842cffe8374b65aa'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-0830-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
report = []
def stored(rel): return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout
J = lambda rel: json.loads(stored(rel))
bevm = J('rpc-base-evm-export/INVENTORY.json'); f318 = J('source-preservation/frozen-0318-export/INVENTORY.json')
f331 = J('source-preservation/frozen-0331-export/INVENTORY.json'); f410 = J('source-preservation/frozen-0410-export/INVENTORY.json')
f420 = J('source-preservation/frozen-0420-export/INVENTORY.json'); f630 = J('source-preservation/frozen-0630-export/INVENTORY.json')
f745 = J('source-preservation/frozen-0745-export/INVENTORY.json'); ncodec = J('rpc-native-codec-export/INVENTORY.json')
P = lambda prefix, side: [('stored', prefix + p['file']) for p in side['patches']]
NINE = P('rpc-base-evm-export/', bevm['enclave'])
A921 = NINE + P('source-preservation/frozen-0331-export/', f331['sides']['a-verifier-authority'])
s, m, d = inv['sides'], inv['merge'], inv['derivative']
RECIPES = {
    'a-windows': (bevm['enclave']['base'], A921 + P('source-preservation/frozen-0410-export/', f410['sides']['a-reth-e2e'])
                  + P('source-preservation/frozen-0420-export/', f420['sides']['a-policy-callers'])
                  + P('source-preservation/frozen-0630-export/', f630['sides']['a-native-relay']), f630['sides']['a-native-relay']['headTree']),
    's-root-doc': (None, P('source-preservation/frozen-0630-export/', f630['sides']['s-holder'])
                   + P('source-preservation/frozen-0745-export/', f745['sides']['s-holder-final']), f745['sides']['s-holder-final']['headTree']),
    'c-storage-write': (None, [], EMPTY),
    'f-final': (ncodec['sides']['c']['base'], P('rpc-native-codec-export/', ncodec['sides']['c'])
                + P('source-preservation/frozen-0410-export/', f410['sides']['c-host-services-cold'])
                + P('source-preservation/frozen-0630-export/', f630['sides']['c-carriers']), f630['sides']['c-carriers']['headTree']),
    'e-derivative': (None, [], EMPTY),
}
assert f630['sides']['a-native-relay']['head'] == s['a-windows']['base']
assert f745['sides']['s-holder-final']['head'] == s['s-root-doc']['base']
assert f630['sides']['c-carriers']['head'] == m['firstParent'] and f630['sides']['f-lifecycle']['head'] == m['secondParent']
def check(name, side, commits):
    start, steps, want = RECIPES[name]
    with tempfile.TemporaryDirectory(prefix='frozen-0830-verify-') as tmp:
        tmp = Path(tmp)
        env = {**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index'), 'GIT_CONFIG_NOSYSTEM': '1'}
        run = lambda *a, **kw: subprocess.run(['git', '-c', 'gc.auto=0', *a], env=env, cwd=tmp, check=True, capture_output=True, **kw)
        run('init', '-q', '--bare', str(tmp / 'r.git')); (tmp / 'r.git/objects/info/alternates').write_text(f'{checkpoint}/.git/objects\n')
        run('read-tree', start) if start else run('read-tree', '--empty')
        for i, (kind, what) in enumerate(steps):
            pf = tmp / f'prior-{i}.patch'; pf.write_bytes(stored(what)); run('apply', '--cached', '--whitespace=nowarn', str(pf))
        tree = run('write-tree').stdout.decode().strip(); ok = tree == want
        report.append(f"{name} base rebuilt from {(start or 'empty')[:9]} + {len(steps)} stored patch(es) in {CK[:9]}: tree {tree} {'OK' if ok else 'MISMATCH want ' + want}")
        for patch, commit in zip(side['patches'], commits):
            run('apply', '--cached', '--whitespace=nowarn', str(out / patch['file']))
            tree = run('write-tree').stdout.decode().strip(); good = tree == commit['tree']; ok &= good
            report.append(f"{name} {commit['commit'][:9]}: tree {tree} {'OK' if good else 'MISMATCH want ' + commit['tree']}")
        return ok and tree == side['headTree']
results = {k: check(k, v, v['commits']) for k, v in s.items()}
results['f-final'] = check('f-final', m, [m['commit']])
results['e-derivative'] = check('e-derivative', d, d['commits'])
report.append('e-derivative trees are the ORIGINAL trees minus fixtures/artifacts/ (originals: '
              + ', '.join(f"{c['commit'][:9]} {c['originalTree'][:9]}" for c in d['commits']) + '); exact originals NOT reproduced')
report.append('RESULT ' + ', '.join(f'{k} reproduced: {v}' for k, v in results.items()))
(out / 'REPRODUCE-CHECK.txt').write_text('\n'.join(report) + '\n'); print('\n'.join(report))
raise SystemExit(0 if all(results.values()) else 1)
