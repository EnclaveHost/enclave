"""Prove the frozen-0931 patches reproduce every recorded tree, offline, from PUSHED checkpoint material (cadf0ebb), in throwaway
bare repos with a temporary index ("0931" = the batch start 2026-10-23T09:31Z, an identifier):
* df8fbafa (a-parity, b-runtime-final) = frozen-0830's a-windows recipe (its base chain + its 5 stored patches)
* e820e240 (s-browser)                 = the same chain + the first 4 of those patches
* 4106c311 (f-rpc-closure)             = frozen-0830's f-final recipe (0757085e chain + the stored merge diff)
* bbf0a009 (c-drain)                   = empty + frozen-0830's 2 c-storage-write patches
* 159fd148's DERIVATIVE tree (e-closure) = empty + frozen-0830's 2 e-derivative patches (827da8c7)
* s-report, root-pg, root-tls, p-l1: root commits from the empty tree. p-l1 and e-closure reproduce DERIVATIVE trees only.
Writes source-preservation/frozen-0931-export/REPRODUCE-CHECK.txt."""
from pathlib import Path
import json, os, subprocess, tempfile
root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = 'cadf0ebb83338d847ef1cb5d3f14a64fe7560098'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-0931-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
report = []
def stored(rel): return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout
J = lambda rel: json.loads(stored(rel))
bevm = J('rpc-base-evm-export/INVENTORY.json'); f331 = J('source-preservation/frozen-0331-export/INVENTORY.json')
f410 = J('source-preservation/frozen-0410-export/INVENTORY.json'); f420 = J('source-preservation/frozen-0420-export/INVENTORY.json')
f630 = J('source-preservation/frozen-0630-export/INVENTORY.json'); f830 = J('source-preservation/frozen-0830-export/INVENTORY.json')
ncodec = J('rpc-native-codec-export/INVENTORY.json')
P = lambda prefix, side: [prefix + p['file'] for p in side['patches']]
X830 = 'source-preservation/frozen-0830-export/'
A921 = P('rpc-base-evm-export/', bevm['enclave']) + P('source-preservation/frozen-0331-export/', f331['sides']['a-verifier-authority'])
A_CHAIN = (A921 + P('source-preservation/frozen-0410-export/', f410['sides']['a-reth-e2e']) + P('source-preservation/frozen-0420-export/', f420['sides']['a-policy-callers'])
           + P('source-preservation/frozen-0630-export/', f630['sides']['a-native-relay']))
aw = f830['sides']['a-windows']
F_CHAIN = (P('rpc-native-codec-export/', ncodec['sides']['c']) + P('source-preservation/frozen-0410-export/', f410['sides']['c-host-services-cold'])
           + P('source-preservation/frozen-0630-export/', f630['sides']['c-carriers']) + P(X830, f830['merge']))
s, d = inv['sides'], inv['derivatives']
BASES = {   # name: (start tree, stored patch chain, the base tree it must rebuild)
    'a-parity': (bevm['enclave']['base'], A_CHAIN + P(X830, aw), aw['headTree']),
    'b-runtime-final': (bevm['enclave']['base'], A_CHAIN + P(X830, aw), aw['headTree']),
    's-browser': (bevm['enclave']['base'], A_CHAIN + P(X830, aw)[:4], aw['commits'][3]['tree']),
    'f-rpc-closure': (ncodec['sides']['c']['base'], F_CHAIN, f830['merge']['headTree']),
    'c-drain': (None, P(X830, f830['sides']['c-storage-write']), f830['sides']['c-storage-write']['headTree']),
    's-report': (None, [], EMPTY), 'root-pg': (None, [], EMPTY), 'root-tls': (None, [], EMPTY),
    'p-l1': (None, [], EMPTY),
    'e-closure': (None, P(X830, f830['derivative']), f830['derivative']['headTree']),
}
assert aw['head'] == s['a-parity']['base'] == s['b-runtime-final']['base'] and aw['commits'][3]['commit'] == s['s-browser']['base']
assert f830['merge']['commit']['commit'] == s['f-rpc-closure']['base'] and f830['sides']['c-storage-write']['head'] == s['c-drain']['base']
assert f830['derivative']['head'] == d['e-closure']['base']
def check(name, side):
    start, steps, want = BASES[name]
    with tempfile.TemporaryDirectory(prefix='frozen-0931-verify-') as tmp:
        tmp = Path(tmp)
        env = {**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index'), 'GIT_CONFIG_NOSYSTEM': '1'}
        run = lambda *a, **kw: subprocess.run(['git', '-c', 'gc.auto=0', *a], env=env, cwd=tmp, check=True, capture_output=True, **kw)
        run('init', '-q', '--bare', str(tmp / 'r.git')); (tmp / 'r.git/objects/info/alternates').write_text(f'{checkpoint}/.git/objects\n')
        run('read-tree', start) if start else run('read-tree', '--empty')
        for i, what in enumerate(steps):
            pf = tmp / f'prior-{i}.patch'; pf.write_bytes(stored(what)); run('apply', '--cached', '--whitespace=nowarn', str(pf))
        tree = run('write-tree').stdout.decode().strip(); ok = tree == want
        report.append(f"{name} base rebuilt from {(start or 'empty')[:9]} + {len(steps)} stored patch(es) in {CK[:9]}: tree {tree} {'OK' if ok else 'MISMATCH want ' + want}")
        for patch, commit in zip(side['patches'], side['commits']):
            run('apply', '--cached', '--whitespace=nowarn', str(out / patch['file']))
            tree = run('write-tree').stdout.decode().strip(); good = tree == commit['tree']; ok &= good
            report.append(f"{name} {commit['commit'][:9]}: tree {tree} {'OK' if good else 'MISMATCH want ' + commit['tree']}")
        return ok and tree == side['headTree']
results = {k: check(k, v) for k, v in {**s, **d}.items()}
for k in ('p-l1', 'e-closure'):
    report.append(f'{k} trees are the ORIGINAL trees minus {d[k]["excluded"]} (originals: '
                  + ', '.join(f"{c['commit'][:9]} {c['originalTree'][:9]}" for c in d[k]['commits'][-2:]) + '); exact originals NOT reproduced')
report.append('RESULT ' + ', '.join(f'{k} reproduced: {v}' for k, v in results.items()))
(out / 'REPRODUCE-CHECK.txt').write_text('\n'.join(report) + '\n'); print('\n'.join(report))
raise SystemExit(0 if all(results.values()) else 1)
