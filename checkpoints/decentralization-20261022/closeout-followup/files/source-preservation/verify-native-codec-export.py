"""Prove the exported patches reproduce every exact commit tree, offline, from checkpoint material only.

* listener: f3159ea's tree is first rebuilt from the files ALREADY STORED in the checkpoint (head-listener-f3159ea-inventory
  paths/modes/blobs; each stored file is re-hashed and must equal its blob), then the 3 patches are applied.
* bridge:   applied to an empty tree (it is a new repository).
* C, D:     applied to f58e03ec4 / 2bbea898, whose objects are borrowed (alternates) from the checkpoint repo.
Each check runs in a throwaway bare repo + temporary index (`git apply --cached`). Nothing is written to any worker or
checkpoint repo. Writes rpc-native-codec-export/REPRODUCE-CHECK.txt.
"""
from pathlib import Path
import json
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
stored = checkpoint / 'checkpoints/decentralization-20261022'
out = base / 'rpc-native-codec-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
report = []


def stored_file(rel):
    for prefix in ('closeout-followup/files', 'closeout-drafts/files'):
        p = stored / prefix / rel
        if p.is_file():
            return p
    raise FileNotFoundError(rel)


def check(name, side, objects_from=None, seed=None):
    with tempfile.TemporaryDirectory(prefix='native-codec-verify-') as tmp:
        tmp = Path(tmp)
        env = {**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index'), 'GIT_CONFIG_NOSYSTEM': '1'}

        def run(*args, **kw):
            return subprocess.run(['git', '-c', 'gc.auto=0', *args], env=env, cwd=tmp, check=True, capture_output=True, **kw)
        run('init', '-q', '--bare', str(tmp / 'r.git'))
        if objects_from:
            (tmp / 'r.git/objects/info/alternates').write_text(str(objects_from) + '\n')
        if seed:
            seed(run)
        elif side['base']:
            run('read-tree', side['base'])
        else:
            run('read-tree', '--empty')
        ok = True
        for patch, commit in zip(side['patches'], side['commits']):
            run('apply', '--cached', '--whitespace=nowarn', str(out / patch['file']))
            tree = run('write-tree').stdout.decode().strip()
            good = tree == commit['tree']
            ok &= good
            report.append(f"{name} {commit['commit'][:9]}: tree {tree} {'OK' if good else 'MISMATCH want ' + commit['tree']}")
        return ok and tree == side['headTree']


def seed_f3159ea(run):
    hl = json.loads(stored_file('source-preservation/head-listener-f3159ea-inventory.json').read_text())
    for f in hl['trackedFiles']:
        data = stored_file('rpc-peer-audit/head-listener/' + f['path']).read_bytes()
        blob = run('hash-object', '-w', '--stdin', input=data).stdout.decode().strip()
        assert blob == f['blob'], (f['path'], blob, f['blob'])
        run('update-index', '--add', '--cacheinfo', f"{f['mode']},{blob},{f['path']}")
    tree = run('write-tree').stdout.decode().strip()
    assert tree == hl['tree'], ('f3159ea tree from checkpoint files', tree, hl['tree'])
    report.append(f"listener f3159ea: tree {tree} OK (rebuilt from {len(hl['trackedFiles'])} files already stored in the checkpoint)")


s = inv['sides']
results = {
    'listener': check('listener', s['listener'], seed=seed_f3159ea),
    'bridge': check('bridge', s['bridge']),
    'c': check('c', s['c'], objects_from=checkpoint / '.git/objects'),
    'd': check('d', s['d'], objects_from=checkpoint / '.git/objects'),
}
report.append('RESULT ' + ', '.join(f'{k} head tree reproduced: {v}' for k, v in results.items()))
(out / 'REPRODUCE-CHECK.txt').write_text('\n'.join(report) + '\n')
print('\n'.join(report))
raise SystemExit(0 if all(results.values()) else 1)
