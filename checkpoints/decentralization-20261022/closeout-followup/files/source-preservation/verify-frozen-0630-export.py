"""Prove the frozen-0630 patches reproduce every exact commit tree, offline, from PUSHED checkpoint material (+ this batch's
own patches for intra-batch bases), in throwaway bare repos with a temporary index:

* 2efc4a83 (root-snapshot-lifecycle, a-native-relay) = the frozen-0420 recipe: 921d60c2 recipe + frozen-0410 a-reth-e2e
  + frozen-0420 a-policy-callers patches
* 7b4dd692 (p-deadline, e-history) = bfbd649d recipe + frozen-0331 p-history-enclave + frozen-0410 p-real-history patches
* 427780bb (c-carriers, f-lifecycle) = rpc-native-codec-export c + frozen-0410 c-host-services-cold patches
* d0775541 (p-compose) = 7b4dd692 + THIS export's p-deadline patches; f6de2364 (root-holder) = THIS export's s-holder
* ROOT commits (root-kernel-lock, s-holder) from the empty tree
* 493ee9ee (d-linux-fec) = its own tree object, present in the checkpoint repo and an ancestor of dfe020abf (= pushed
  origin/candidate/decentralized-control-20261022; the push job re-checks the remote tip)
Writes source-preservation/frozen-0630-export/REPRODUCE-CHECK.txt.
"""
from pathlib import Path
import json
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = '8ac1aa51c36ec4e8a1fa3d5a60c0438a721190ab'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-0630-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
ALTERNATES = [checkpoint / '.git/objects']
EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
N493, DFE = '493ee9ee07497c94159ec4f6916e9ea920d31959', 'dfe020abf1794bedc42943e43fe85eb02593dd8d'
report = []


def stored(rel):
    return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout


def ck(*args):
    return subprocess.run(['git', '-C', str(checkpoint), *args], check=True, capture_output=True, text=True).stdout


bevm = json.loads(stored('rpc-base-evm-export/INVENTORY.json'))
f318 = json.loads(stored('source-preservation/frozen-0318-export/INVENTORY.json'))
f331 = json.loads(stored('source-preservation/frozen-0331-export/INVENTORY.json'))
f410 = json.loads(stored('source-preservation/frozen-0410-export/INVENTORY.json'))
f420 = json.loads(stored('source-preservation/frozen-0420-export/INVENTORY.json'))
ncodec = json.loads(stored('rpc-native-codec-export/INVENTORY.json'))
s = inv['sides']


def patches(prefix, side):
    return [('stored', prefix + p['file']) for p in side['patches']]


def local(side):
    return [('local', p['file']) for p in side['patches']]


NINE = patches('rpc-base-evm-export/', bevm['enclave'])
A921 = NINE + patches('source-preservation/frozen-0331-export/', f331['sides']['a-verifier-authority'])
BFBD = NINE + patches('source-preservation/frozen-0318-export/', f318['sides']['witness-enclave'])
A2EFC = (bevm['enclave']['base'], A921 + patches('source-preservation/frozen-0410-export/', f410['sides']['a-reth-e2e'])
         + patches('source-preservation/frozen-0420-export/', f420['sides']['a-policy-callers']), f420['sides']['a-policy-callers']['headTree'])
P7B4 = (bevm['enclave']['base'], BFBD + patches('source-preservation/frozen-0331-export/', f331['sides']['p-history-enclave'])
        + patches('source-preservation/frozen-0410-export/', f410['sides']['p-real-history']), f410['sides']['p-real-history']['headTree'])
C427 = (ncodec['sides']['c']['base'], patches('rpc-native-codec-export/', ncodec['sides']['c'])
        + patches('source-preservation/frozen-0410-export/', f410['sides']['c-host-services-cold']), f410['sides']['c-host-services-cold']['headTree'])
assert f420['sides']['a-policy-callers']['head'] == s['root-snapshot-lifecycle']['base'] == s['a-native-relay']['base']
assert f410['sides']['p-real-history']['head'] == s['p-deadline']['base'] == s['e-history']['base']
assert f410['sides']['c-host-services-cold']['head'] == s['c-carriers']['base'] == s['f-lifecycle']['base']
assert s['p-deadline']['head'] == s['p-compose']['base'] and s['s-holder']['head'] == s['root-holder']['base']
assert s['d-linux-fec']['base'] == N493
subprocess.run(['git', '-C', str(checkpoint), 'merge-base', '--is-ancestor', N493, DFE], check=True)
N493_TREE = ck('rev-parse', N493 + '^{tree}').strip()
RECIPES = {
    'root-kernel-lock': (None, [], EMPTY),
    'root-snapshot-lifecycle': A2EFC, 'a-native-relay': A2EFC,
    'p-deadline': P7B4, 'e-history': P7B4,
    'p-compose': (P7B4[0], P7B4[1] + local(s['p-deadline']), s['p-deadline']['headTree']),
    'c-carriers': C427, 'f-lifecycle': C427,
    's-holder': (None, [], EMPTY),
    'root-holder': (None, local(s['s-holder']), s['s-holder']['headTree']),
    'd-linux-fec': (N493, [], N493_TREE),
}
assert set(RECIPES) == set(s)


def check(name, side):
    start, steps, want = RECIPES[name]
    with tempfile.TemporaryDirectory(prefix='frozen-0630-verify-') as tmp:
        tmp = Path(tmp)
        env = {**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index'), 'GIT_CONFIG_NOSYSTEM': '1'}

        def run(*args, **kw):
            return subprocess.run(['git', '-c', 'gc.auto=0', *args], env=env, cwd=tmp, check=True, capture_output=True, **kw)
        run('init', '-q', '--bare', str(tmp / 'r.git'))
        (tmp / 'r.git/objects/info/alternates').write_text(''.join(f'{a}\n' for a in ALTERNATES))
        run('read-tree', start) if start else run('read-tree', '--empty')
        for i, (kind, what) in enumerate(steps):
            pf = tmp / f'prior-{i}.patch'
            pf.write_bytes(stored(what) if kind == 'stored' else (out / what).read_bytes())
            run('apply', '--cached', '--whitespace=nowarn', str(pf))
        tree = run('write-tree').stdout.decode().strip()
        ok = tree == want
        report.append(f"{name} base {side['base'][:9] if side['base'] else 'none (root commit)'} rebuilt from {(start or 'empty')[:9]} + "
                      f"{sum(k == 'stored' for k, _ in steps)} stored patch(es) in {CK[:9]} + {sum(k == 'local' for k, _ in steps)} "
                      f"patch(es) of this export: tree {tree} {'OK' if ok else 'MISMATCH want ' + str(want)}")
        for patch, commit in zip(side['patches'], side['commits']):
            run('apply', '--cached', '--whitespace=nowarn', str(out / patch['file']))
            tree = run('write-tree').stdout.decode().strip()
            good = tree == commit['tree']
            ok &= good
            report.append(f"{name} {commit['commit'][:9]}: tree {tree} {'OK' if good else 'MISMATCH want ' + commit['tree']}")
        return ok and tree == side['headTree']


results = {name: check(name, side) for name, side in s.items()}
report.append(f'493ee9ee is an ancestor of dfe020abf (checked in the checkpoint repo); its tree {N493_TREE}')
report.append('RESULT ' + ', '.join(f'{k} head tree reproduced: {v}' for k, v in results.items()))
(out / 'REPRODUCE-CHECK.txt').write_text('\n'.join(report) + '\n')
print('\n'.join(report))
raise SystemExit(0 if all(results.values()) else 1)
