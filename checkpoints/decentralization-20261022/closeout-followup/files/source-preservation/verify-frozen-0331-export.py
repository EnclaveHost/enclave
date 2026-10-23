"""Prove the frozen-0331 patches reproduce every exact commit tree, offline, from PUSHED checkpoint material only.

Every base is first rebuilt from material committed in checkpoint 552fb9f5 (read with `git show`, never from a worker
tree), then the new series is applied:
* 9fdc1418c (e-sia-cache, a-verifier-authority) = public dfe020abf + 4 stored rpc-base-evm-export enclave patches
* bfbd649d (p-history-enclave)                  = that + 2 stored frozen-0318-export witness-enclave patches
* 1ec2c1a5 (p-history-helios)                   = upstream 2af9b418 (objects from the read-only vendor-inspect clone) + 4 stored
                                                  helios patches + snappy from the stored hex fixture + 1 stored frozen-0318 patch
* 0d7e6b8  (s-bridge)                           = the 12 stored sia-whole-restore-harness files (each re-hashed to its blob)
* b84c5a11 (e-receipt-witness)                  = empty tree; its one binary is re-added from the exported hex
Each check runs in a throwaway bare repo + temporary index (`git apply --cached`). Nothing is written to any worker or
checkpoint repo. Writes source-preservation/frozen-0331-export/REPRODUCE-CHECK.txt.
"""
from pathlib import Path
import json
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = '552fb9f5460b996c30a69c2600c60c5e38b7d83f'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-0331-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
ALTERNATES = [checkpoint / '.git/objects', base / 'rpc-priority/vendor-inspect/helios-src-2af9b418/.git/objects']
report = []


def stored(rel):
    return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout


bevm = json.loads(stored('rpc-base-evm-export/INVENTORY.json'))
f318 = json.loads(stored('source-preservation/frozen-0318-export/INVENTORY.json'))


def patches(prefix, side):
    return [('patch', prefix + p['file']) for p in side['patches']]


def snappy(run):
    s = bevm['helios']['snappyReconstruction']
    data = bytes.fromhex(stored(s['fromHexFixtureInCheckpoint'].removeprefix(
        'checkpoints/decentralization-20261022/closeout-followup/files/')).decode().strip())
    blob = run('hash-object', '-w', '--stdin', input=data).stdout.decode().strip()
    assert blob == s['blob'], (blob, s['blob'])
    run('update-index', '--add', '--cacheinfo', f"100644,{blob},{s['path']}")


def harness_files(side):
    def seed(run):
        for f in side['baseTreeFiles']:
            data = stored('sia-whole-restore-harness/' + f['path'])
            blob = run('hash-object', '-w', '--stdin', input=data).stdout.decode().strip()
            assert blob == f['blob'], (f['path'], blob, f['blob'])
            run('update-index', '--add', '--cacheinfo', f"{f['mode']},{blob},{f['path']}")
    return seed


NINE = (bevm['enclave']['base'], patches('rpc-base-evm-export/', bevm['enclave']), bevm['enclave']['headTree'])
s = inv['sides']
RECIPES = {
    'e-sia-cache': NINE,
    'a-verifier-authority': NINE,
    'p-history-enclave': (bevm['enclave']['base'],
                          NINE[1] + patches('source-preservation/frozen-0318-export/', f318['sides']['witness-enclave']),
                          f318['sides']['witness-enclave']['headTree']),
    'p-history-helios': (bevm['helios']['base'],
                         patches('rpc-base-evm-export/', bevm['helios']) + [('hook', snappy)]
                         + patches('source-preservation/frozen-0318-export/', f318['sides']['witness-helios']),
                         f318['sides']['witness-helios']['headTree']),
    's-bridge': (None, [('hook', harness_files(s['s-bridge']))], s['s-bridge'].get('baseTree')),
    'e-receipt-witness': (None, [], '4b825dc642cb6eb9a060e54bf8d69288fbee4904'),
}
assert bevm['enclave']['head'].startswith('9fdc1418c') and f318['sides']['witness-enclave']['head'] == s['p-history-enclave']['base']
assert f318['sides']['witness-helios']['head'] == s['p-history-helios']['base']


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
    with tempfile.TemporaryDirectory(prefix='frozen-0331-verify-') as tmp:
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
