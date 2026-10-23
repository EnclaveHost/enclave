"""Prove the exported patches reproduce the exact Enclave 9fdc1418c and Helios eeffcc9 trees from their pinned bases.

Each check runs in a throwaway bare repo whose only objects are borrowed through `alternates` from a repo that has
the BASE (the checkpoint repo for dfe020abf; the upstream helios clone for 0.12.0, which lacks the Enclave commits).
The patches are applied to a temporary index (`git apply --cached`); the snappy test object is rebuilt from the
checkpoint's hex fixture. Nothing is written to any worker or checkpoint repo. Writes REPRODUCE-CHECK.txt.
"""
from pathlib import Path
import json
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
checkpoint = root / 'work/source-checkpoint-20261022/main-repo'
out = base / 'rpc-base-evm-export'
inv = json.loads((out / 'INVENTORY.json').read_text())
report = []


def check(name, spec, objects_from, before_last=None):
    with tempfile.TemporaryDirectory(prefix='base-evm-verify-') as tmp:
        tmp = Path(tmp)
        env = {**os.environ, 'GIT_DIR': str(tmp / 'r.git'), 'GIT_INDEX_FILE': str(tmp / 'index'), 'GIT_CONFIG_NOSYSTEM': '1'}

        def run(*args, **kw):
            return subprocess.run(['git', '-c', 'gc.auto=0', *args], env=env, cwd=tmp, check=True, capture_output=True, **kw)
        run('init', '-q', '--bare', str(tmp / 'r.git'))
        (tmp / 'r.git/objects/info/alternates').write_text(str(objects_from) + '\n')
        run('read-tree', spec['base'])
        tree = None
        for i, (patch, commit) in enumerate(zip(spec['patches'], spec['commits'])):
            run('apply', '--cached', '--whitespace=nowarn', str(out / patch['file']))
            if before_last and i == len(spec['commits']) - 1:
                before_last(run)
            tree = run('write-tree').stdout.decode().strip()
            report.append(f"{name} {commit['commit'][:9]}: tree {tree} {'OK' if tree == commit['tree'] else 'MISMATCH want ' + commit['tree']}")
        return tree == spec['headTree']


def add_snappy(run):
    s = inv['helios']['snappyReconstruction']
    data = bytes.fromhex((checkpoint / s['fromHexFixtureInCheckpoint']).read_text().strip())
    blob = run('hash-object', '-w', '--stdin', input=data).stdout.decode().strip()
    assert blob == s['blob'], (blob, s['blob'])
    run('update-index', '--add', '--cacheinfo', f"100644,{blob},{s['path']}")


ok_enclave = check('enclave', inv['enclave'], checkpoint / '.git/objects')
ok_helios = check('helios', inv['helios'], base / 'rpc-priority/vendor-inspect/helios-src-2af9b418/.git/objects', add_snappy)
report.append(f'RESULT enclave head tree reproduced from dfe020abf + 4 patches: {ok_enclave}; helios head tree reproduced from '
              f'0.12.0 (2af9b418) + 4 patches + snappy from the checkpoint hex fixture: {ok_helios}')
(out / 'REPRODUCE-CHECK.txt').write_text('\n'.join(report) + '\n')
print('\n'.join(report))
raise SystemExit(0 if ok_enclave and ok_helios else 1)
