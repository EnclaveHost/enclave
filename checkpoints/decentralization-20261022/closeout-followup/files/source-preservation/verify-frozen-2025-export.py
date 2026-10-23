"""Prove the frozen-2025 patches reproduce every recorded tree, offline, from PUSHED checkpoint material (dc551728), in throwaway bare
repos with a temporary index ("2025" = the batch start 2026-10-23T20:25Z, an identifier). Bases are rebuilt from the stored patch chains
of earlier exports (frozen-1951's own base chains, extended by frozen-1951's patches). durability3 continues frozen-1951 durability2
(touched files only): its stored base-files/ + patches must give every touched path's recorded blob at every commit.
Writes source-preservation/frozen-2025-export/REPRODUCE-CHECK.txt."""
from pathlib import Path
import json, os, subprocess, tempfile
root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = 'dc551728a71e29adb8eda127f4607395a4d97b66'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-2025-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
report = []
def stored(rel): return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout
J = lambda rel: json.loads(stored(rel))
X = lambda n: f'source-preservation/frozen-{n}-export/'
f331, f410, f420, f630, f830, f931, f1339, f1517, f1639, f1852, f1951 = (J(X(n) + 'INVENTORY.json') for n in
    ('0331', '0410', '0420', '0630', '0830', '0931', '1339', '1517', '1639', '1852', '1951'))
bevm = J('rpc-base-evm-export/INVENTORY.json'); ncodec = J('rpc-native-codec-export/INVENTORY.json')
P = lambda prefix, side: [prefix + p['file'] for p in side['patches']]
s, d = inv['sides'], inv['derivatives']
A_CHAIN = (P('rpc-base-evm-export/', bevm['enclave']) + P(X('0331'), f331['sides']['a-verifier-authority']) + P(X('0410'), f410['sides']['a-reth-e2e'])
           + P(X('0420'), f420['sides']['a-policy-callers']) + P(X('0630'), f630['sides']['a-native-relay']))
g = f1951['sides']; eg = f1639['sides']['e-gen']
sd = {**s, **d}
assert g['custody-release']['head'] == sd['custody-release2']['base'] and g['dashboard']['head'] == sd['dashboard2']['base']
assert g['custody-live2']['head'] == sd['custody-live3']['base'] and g['durability2']['head'] == sd['durability3']['base']
assert g['dashboard']['base'] == eg['head'] and g['custody-live2']['base'] == f1852['sides']['custody-live']['head']
# frozen-1951's own dashboard base chain (verify-frozen-1951-export.py), then frozen-1951's dashboard patches
DASH_1951_BASE = (A_CHAIN + P(X('0830'), f830['sides']['a-windows'])[:4] + P(X('0931'), f931['sides']['s-browser'])
                  + P(X('1339'), f1339['sides']['e-wallet']) + P(X('1517'), f1517['sides']['e-prod']) + P(X('1639'), eg))
BASES = {'custody-release2': (None, P(X('1951'), g['custody-release']), g['custody-release']['headTree']),
         'dashboard2': (bevm['enclave']['base'], DASH_1951_BASE + P(X('1951'), g['dashboard']), g['dashboard']['headTree']),
         'custody-live3': (None, P(X('1852'), f1852['sides']['custody-live']) + P(X('1951'), g['custody-live2']), g['custody-live2']['headTree'])}
for k in {**s, **d}:
    BASES.setdefault(k, (None, [], EMPTY))
def repo(tmp):
    env = {**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index'), 'GIT_CONFIG_NOSYSTEM': '1'}
    run = lambda *a, **kw: subprocess.run(['git', '-c', 'gc.auto=0', *a], env=env, cwd=tmp, check=True, capture_output=True, **kw)
    run('init', '-q', '--bare', str(tmp / 'r.git')); (tmp / 'r.git/objects/info/alternates').write_text(f'{checkpoint}/.git/objects\n')
    return run
def check(name, side):
    start, steps, want = BASES[name]
    with tempfile.TemporaryDirectory(prefix='frozen-2025-verify-') as tmp:
        tmp = Path(tmp); run = repo(tmp)
        run('read-tree', start) if start else run('read-tree', '--empty')
        for i, what in enumerate(steps):
            pf = tmp / f'prior-{i}.patch'; pf.write_bytes(stored(what)); run('apply', '--cached', '--whitespace=nowarn', str(pf))
        tree = run('write-tree').stdout.decode().strip(); ok = tree == want
        report.append(f"{name} base rebuilt from {(start or 'empty')[:9]} + {len(steps)} stored patch(es) in {CK[:9]}: tree {tree} {'OK' if ok else 'MISMATCH want ' + want}")
        patches = iter(side['patches'])
        for commit in side['commits']:
            if commit.get('emptyAfterExclusion'):
                good = tree == commit['tree']; ok &= good
                report.append(f"{name} {commit['commit'][:9]}: excluded-paths-only commit, derived tree {tree} {'unchanged OK' if good else 'MISMATCH want ' + commit['tree']}")
                continue
            run('apply', '--cached', '--whitespace=nowarn', str(out / next(patches)['file']))
            tree = run('write-tree').stdout.decode().strip(); good = tree == commit['tree']; ok &= good
            report.append(f"{name} {commit['commit'][:9]}: tree {tree} {'OK' if good else 'MISMATCH want ' + commit['tree']}")
        assert next(patches, None) is None, f'{name}: unused patches'
        return ok and tree == side['headTree']
def check_touched(name, side):
    # base index = ONLY the stored base files of the touched paths; each patch must apply and give the recorded blob for every touched path
    with tempfile.TemporaryDirectory(prefix='frozen-2025-verify-') as tmp:
        tmp = Path(tmp); run = repo(tmp); run('read-tree', '--empty'); ok = True
        for b in side['baseFiles']:
            blob = run('hash-object', '-w', str(out / b['file'])).stdout.decode().strip(); good = blob == b['blob']; ok &= good
            run('update-index', '--add', '--cacheinfo', f"{b['mode']},{blob},{b['path']}")
            report.append(f"{name} base file {b['path']}: blob {blob[:9]} {'OK' if good else 'MISMATCH want ' + b['blob']}")
        patches = iter(side['patches'])
        for commit in side['commits']:
            run('apply', '--cached', '--whitespace=nowarn', str(out / next(patches)['file']))
            want = {e['path']: e['blob'] for e in commit['touchedBlobs']}; got = {}
            for p in want:
                r = subprocess.run(['git', 'ls-files', '-s', '--', p], env={**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index')},
                                   cwd=tmp, capture_output=True, text=True, check=True).stdout.split()
                got[p] = r[1] if r else None
            good = got == want; ok &= good
            report.append(f"{name} {commit['commit'][:9]}: {len(got)} touched path blobs {'OK' if good else 'MISMATCH ' + json.dumps({p: (got[p], want[p]) for p in got if got[p] != want[p]})}")
        assert next(patches, None) is None, f'{name}: unused patches'
        report.append(f"{name}: full tree {side['headTree'][:9]} on base {side['base'][:9]} NOT reproduced (base not in pushed material; see baseTreeNotReproduced)")
        return ok
results = {k: (check_touched(k, v) if 'baseFiles' in v else check(k, v)) for k, v in {**s, **d}.items()}
for k in d:
    report.append(f'{k} trees are the ORIGINAL trees minus {d[k]["excluded"]} held at the base (head original {d[k]["originalHeadTree"][:9]}); exact originals NOT reproduced')
report.append('RESULT ' + ', '.join(f'{k} reproduced: {v}' + (' (touched files only)' if 'baseFiles' in ({**s, **d}[k]) else '') for k, v in results.items()))
(out / 'REPRODUCE-CHECK.txt').write_text('\n'.join(report) + '\n'); print('\n'.join(report))
raise SystemExit(0 if all(results.values()) else 1)
