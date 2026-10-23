"""Prove the frozen-0745 patches reproduce every exact commit tree, offline, from PUSHED checkpoint material (871e2197), in
throwaway bare repos with a temporary index:
* fec43a6a (d-linux-carrier) = the 493ee9ee tree (an ancestor of pushed dfe020abf) + frozen-0630 d-linux-fec patches
* f6de2364 (s-holder-final)  = the empty tree + frozen-0630 s-holder patches
* ROOT commits (root-wallet-fix, root-cache-budget) from the empty tree
Writes source-preservation/frozen-0745-export/REPRODUCE-CHECK.txt.
"""
from pathlib import Path
import json
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = '871e21975828c0b9aea463ba6c7affd249a71732'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-0745-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
ALTERNATES = [checkpoint / '.git/objects']
EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
N493, DFE = '493ee9ee07497c94159ec4f6916e9ea920d31959', 'dfe020abf1794bedc42943e43fe85eb02593dd8d'
report = []


def stored(rel):
    return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout


def ck(*args):
    return subprocess.run(['git', '-C', str(checkpoint), *args], check=True, capture_output=True, text=True).stdout


f630 = json.loads(stored('source-preservation/frozen-0630-export/INVENTORY.json'))
s = inv['sides']


def patches(prefix, side):
    return [('stored', prefix + p['file']) for p in side['patches']]


assert f630['sides']['d-linux-fec']['head'] == s['d-linux-carrier']['base']
assert f630['sides']['s-holder']['head'] == s['s-holder-final']['base']
assert f630['sides']['d-linux-fec']['base'] == N493
subprocess.run(['git', '-C', str(checkpoint), 'merge-base', '--is-ancestor', N493, DFE], check=True)
RECIPES = {
    'd-linux-carrier': (N493, patches('source-preservation/frozen-0630-export/', f630['sides']['d-linux-fec']), f630['sides']['d-linux-fec']['headTree']),
    's-holder-final': (None, patches('source-preservation/frozen-0630-export/', f630['sides']['s-holder']), f630['sides']['s-holder']['headTree']),
    'root-wallet-fix': (None, [], EMPTY), 'root-cache-budget': (None, [], EMPTY),
}
assert set(RECIPES) == set(s)


def check(name, side):
    start, steps, want = RECIPES[name]
    with tempfile.TemporaryDirectory(prefix='frozen-0745-verify-') as tmp:
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
report.append('493ee9ee is an ancestor of dfe020abf (checked in the checkpoint repo)')
report.append('RESULT ' + ', '.join(f'{k} head tree reproduced: {v}' for k, v in results.items()))
(out / 'REPRODUCE-CHECK.txt').write_text('\n'.join(report) + '\n')
print('\n'.join(report))
raise SystemExit(0 if all(results.values()) else 1)
