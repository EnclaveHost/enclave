"""Prove the frozen-0410 patches reproduce every exact commit tree, offline, from PUSHED checkpoint material only.

Every base is first rebuilt from material committed in checkpoint f6668d86 (read with `git show`, never from a worker
tree), then the new series is applied:
* 921d60c2 (a-reth-e2e, b-verifier-deadline) = public dfe020abf + 4 rpc-base-evm-export enclave patches + 1 frozen-0331 patch
* d7f520bf (c-host-services-cold)            = checkpoint commit f58e03ec4 + 7 rpc-native-codec-export c patches
* b744ba19 (d-linux-hold-final)              = checkpoint commit 2bbea898 + 1 rpc-native-codec-export d patch + 1 frozen-0318 patch
* bfbd649d (e-sia-cache-compose)             = 9fdc1418c (as above) + 2 frozen-0318 witness-enclave patches
* ce7c1b73 (p-real-history)                  = bfbd649d + 2 frozen-0331 p-history-enclave patches
Each check runs in a throwaway bare repo + temporary index (`git apply --cached`). Nothing is written to any worker or
checkpoint repo. Writes source-preservation/frozen-0410-export/REPRODUCE-CHECK.txt.
"""
from pathlib import Path
import json
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = 'f6668d86584f67a5dee5b9a5261d9a725a4de754'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-0410-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
ALTERNATES = [checkpoint / '.git/objects']
report = []


def stored(rel):
    return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout


bevm = json.loads(stored('rpc-base-evm-export/INVENTORY.json'))
f318 = json.loads(stored('source-preservation/frozen-0318-export/INVENTORY.json'))
f331 = json.loads(stored('source-preservation/frozen-0331-export/INVENTORY.json'))
ncodec = json.loads(stored('rpc-native-codec-export/INVENTORY.json'))


def patches(prefix, side):
    return [('patch', prefix + p['file']) for p in side['patches']]


NINE = patches('rpc-base-evm-export/', bevm['enclave'])
A921 = NINE + patches('source-preservation/frozen-0331-export/', f331['sides']['a-verifier-authority'])
BFBD = NINE + patches('source-preservation/frozen-0318-export/', f318['sides']['witness-enclave'])
s = inv['sides']
RECIPES = {
    'a-reth-e2e': (bevm['enclave']['base'], A921, f331['sides']['a-verifier-authority']['headTree']),
    'b-verifier-deadline': (bevm['enclave']['base'], A921, f331['sides']['a-verifier-authority']['headTree']),
    'c-host-services-cold': (ncodec['sides']['c']['base'], patches('rpc-native-codec-export/', ncodec['sides']['c']),
                             ncodec['sides']['c']['headTree']),
    'd-linux-hold-final': (ncodec['sides']['d']['base'], patches('rpc-native-codec-export/', ncodec['sides']['d'])
                           + patches('source-preservation/frozen-0318-export/', f318['sides']['d-review']),
                           f318['sides']['d-review']['headTree']),
    'e-sia-cache-compose': (bevm['enclave']['base'], BFBD, f318['sides']['witness-enclave']['headTree']),
    'p-real-history': (bevm['enclave']['base'], BFBD + patches('source-preservation/frozen-0331-export/', f331['sides']['p-history-enclave']),
                       f331['sides']['p-history-enclave']['headTree']),
}
assert f331['sides']['a-verifier-authority']['head'] == s['a-reth-e2e']['base'] == s['b-verifier-deadline']['base']
assert ncodec['sides']['c']['head'] == s['c-host-services-cold']['base']
assert f318['sides']['d-review']['head'] == s['d-linux-hold-final']['base']
assert f318['sides']['witness-enclave']['head'] == s['e-sia-cache-compose']['base']
assert f331['sides']['p-history-enclave']['head'] == s['p-real-history']['base']


def add_hex_binaries(side):
    def hook(run):
        for f in side['changedFiles']:
            if 'storedAsHex' in f:
                folder = out / Path(side['patches'][0]['file']).parts[0] / 'files'
                data = bytes.fromhex((folder / f['storedAsHex']).read_text().strip())
                blob = run('hash-object', '-w', '--stdin', input=data).stdout.decode().strip()
                assert blob == f['blob'], (f['path'], blob, f['blob'])
                run('update-index', '--add', '--cacheinfo', f"{f['mode']},{blob},{f['path']}")
    return hook


def check(name, side):
    start, steps, want = RECIPES[name]
    with tempfile.TemporaryDirectory(prefix='frozen-0410-verify-') as tmp:
        tmp = Path(tmp)
        env = {**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index'), 'GIT_CONFIG_NOSYSTEM': '1'}

        def run(*args, **kw):
            return subprocess.run(['git', '-c', 'gc.auto=0', *args], env=env, cwd=tmp, check=True, capture_output=True, **kw)
        run('init', '-q', '--bare', str(tmp / 'r.git'))
        (tmp / 'r.git/objects/info/alternates').write_text(''.join(f'{a}\n' for a in ALTERNATES))
        run('read-tree', start) if start else run('read-tree', '--empty')
        for i, (kind, what) in enumerate(steps):
            if kind == 'hook':
                what(run)
                continue
            pf = tmp / f'prior-{i}.patch'
            pf.write_bytes(stored(what))
            run('apply', '--cached', '--whitespace=nowarn', str(pf))
        tree = run('write-tree').stdout.decode().strip()
        ok = tree == want
        report.append(f"{name} base {side['base'][:9] if side['base'] else 'none (root commit)'} rebuilt from {(start or 'empty')[:9]} + "
                      f"{sum(k == 'patch' for k, _ in steps)} stored patch(es) in {CK[:9]}: tree {tree} "
                      f"{'OK' if ok else 'MISMATCH want ' + str(want)}")
        hexhook = add_hex_binaries(side)
        for patch, commit in zip(side['patches'], side['commits']):
            run('apply', '--cached', '--whitespace=nowarn', str(out / patch['file']))
            hexhook(run)
            tree = run('write-tree').stdout.decode().strip()
            good = tree == commit['tree']
            ok &= good
            report.append(f"{name} {commit['commit'][:9]}: tree {tree} {'OK' if good else 'MISMATCH want ' + commit['tree']}")
        return ok and tree == side['headTree']


results = {name: check(name, side) for name, side in s.items()}
report.append('RESULT ' + ', '.join(f'{k} head tree reproduced: {v}' for k, v in results.items()))
(out / 'REPRODUCE-CHECK.txt').write_text('\n'.join(report) + '\n')
print('\n'.join(report))
raise SystemExit(0 if all(results.values()) else 1)
