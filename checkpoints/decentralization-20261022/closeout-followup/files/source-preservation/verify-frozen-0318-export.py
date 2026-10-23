"""Prove the frozen-0318 patches reproduce every exact commit tree, offline, from PUSHED checkpoint material only.

Every base is first rebuilt from the prior exports as committed in checkpoint 7b477d57 (read with `git show`, never from
a worker tree), then the new series is applied:
* witness-enclave: dfe020abf (checkpoint objects) + 4 stored rpc-base-evm-export enclave patches = 9fdc1418c (tree 5c84c3da),
                   then 2 new patches.
* witness-helios:  upstream a16z/helios 0.12.0 2af9b418 (objects borrowed from the read-only vendor-inspect clone) + 4 stored
                   helios patches + the snappy test object from the stored hex fixture = eeffcc9 (tree 2171ad2b), then 1 patch.
* d-review:        2bbea898 (checkpoint objects) + the stored D patch = 09ff3ed5, then 1 patch.
Each check runs in a throwaway bare repo + temporary index (`git apply --cached`). Nothing is written to any worker or
checkpoint repo. Writes source-preservation/frozen-0318-export/REPRODUCE-CHECK.txt.
"""
from pathlib import Path
import json
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
CK = '7b477d578973dd11ebada8cc448bc1b3913f3bd9'
STORED = 'checkpoints/decentralization-20261022/closeout-followup/files/'
out = base / 'source-preservation/frozen-0318-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
report = []


def stored(rel):
    return subprocess.run(['git', '-C', str(checkpoint), 'show', f'{CK}:{STORED}{rel}'], check=True, capture_output=True).stdout


def check(name, side, objects_from, start, prior):
    """prior = (label, [stored patch rel paths], expected base tree, optional hook before the last prior patch's write)"""
    with tempfile.TemporaryDirectory(prefix='frozen-0318-verify-') as tmp:
        tmp = Path(tmp)
        env = {**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index'), 'GIT_CONFIG_NOSYSTEM': '1'}

        def run(*args, **kw):
            return subprocess.run(['git', '-c', 'gc.auto=0', *args], env=env, cwd=tmp, check=True, capture_output=True, **kw)
        run('init', '-q', '--bare', str(tmp / 'r.git'))
        (tmp / 'r.git/objects/info/alternates').write_text(str(objects_from) + '\n')
        run('read-tree', start)
        label, patches, want, hook = prior
        for i, rel in enumerate(patches):
            pf = tmp / f'prior-{i}.patch'
            pf.write_bytes(stored(rel))
            run('apply', '--cached', '--whitespace=nowarn', str(pf))
        if hook:
            hook(run)
        tree = run('write-tree').stdout.decode().strip()
        base_ok = tree == want
        report.append(f"{name} base {side['base'][:9]} rebuilt from {start[:9]} + {len(patches)} stored {label} patch(es) "
                      f"in {CK[:9]}: tree {tree} {'OK' if base_ok else 'MISMATCH want ' + want}")
        ok = base_ok
        for patch, commit in zip(side['patches'], side['commits']):
            run('apply', '--cached', '--whitespace=nowarn', str(out / patch['file']))
            tree = run('write-tree').stdout.decode().strip()
            good = tree == commit['tree']
            ok &= good
            report.append(f"{name} {commit['commit'][:9]}: tree {tree} {'OK' if good else 'MISMATCH want ' + commit['tree']}")
        return ok and tree == side['headTree']


bevm = json.loads(stored('rpc-base-evm-export/INVENTORY.json'))
ncx = json.loads(stored('rpc-native-codec-export/INVENTORY.json'))


def add_snappy(run):
    s = bevm['helios']['snappyReconstruction']
    hexpath = s['fromHexFixtureInCheckpoint'].removeprefix('checkpoints/decentralization-20261022/closeout-followup/files/')
    data = bytes.fromhex(stored(hexpath).decode().strip())
    blob = run('hash-object', '-w', '--stdin', input=data).stdout.decode().strip()
    assert blob == s['blob'], (blob, s['blob'])
    run('update-index', '--add', '--cacheinfo', f"100644,{blob},{s['path']}")


s = inv['sides']
assert bevm['enclave']['head'].startswith(s['witness-enclave']['base'][:9]) and bevm['helios']['head'] == s['witness-helios']['base']
assert ncx['sides']['d']['head'] == s['d-review']['base']
results = {
    'witness-enclave': check('witness-enclave', s['witness-enclave'], checkpoint / '.git/objects', bevm['enclave']['base'],
                             ('rpc-base-evm-export', ['rpc-base-evm-export/' + p['file'] for p in bevm['enclave']['patches']],
                              bevm['enclave']['headTree'], None)),
    'witness-helios': check('witness-helios', s['witness-helios'],
                            base / 'rpc-priority/vendor-inspect/helios-src-2af9b418/.git/objects', bevm['helios']['base'],
                            ('rpc-base-evm-export', ['rpc-base-evm-export/' + p['file'] for p in bevm['helios']['patches']],
                             bevm['helios']['headTree'], add_snappy)),
    'd-review': check('d-review', s['d-review'], checkpoint / '.git/objects', ncx['sides']['d']['base'],
                      ('rpc-native-codec-export', ['rpc-native-codec-export/' + p['file'] for p in ncx['sides']['d']['patches']],
                       ncx['sides']['d']['headTree'], None)),
}
report.append('RESULT ' + ', '.join(f'{k} head tree reproduced: {v}' for k, v in results.items()))
(out / 'REPRODUCE-CHECK.txt').write_text('\n'.join(report) + '\n')
print('\n'.join(report))
raise SystemExit(0 if all(results.values()) else 1)
