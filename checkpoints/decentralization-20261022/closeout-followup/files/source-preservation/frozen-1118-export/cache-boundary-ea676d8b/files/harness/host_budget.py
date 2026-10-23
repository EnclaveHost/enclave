#!/usr/bin/env python3
"""S's budget.py (959e56f, unmodified) on the REAL host filesystem holding this workspace (ext4 on dm-crypt `cryptroot`),
run inside a private user+mount namespace whose /etc is an overlay: the CANONICAL ledger path
/etc/enclave-rpc-cache/nvme-cache-budget.json and a fixture /etc/machine-id exist only in this namespace (the real /etc
is never written). Files: 12 MiB in an owned new directory. Measures actual st_blocks against maxBytes and refusals."""
import hashlib, importlib.util, json, os, subprocess, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('budget', HERE.parent / 'vendor/holder/budget.py')
B = importlib.util.module_from_spec(spec); spec.loader.exec_module(B)
D = Path(sys.argv[1]); D.mkdir(parents=True)
MID = '0e0f0e0f0e0f0e0f0e0f0e0f0e0f0e0f'
assert Path('/etc/machine-id').read_text().strip() == MID, 'overlay /etc not active'
files = [{'path': str(D / 'cache-data.img'), 'bytes': 8 << 20}, {'path': str(D / 'cache-meta.img'), 'bytes': 4 << 20}]
slack = B.required_headroom({'blockBytes': 4096, 'files': files})
r = {'id': 'host-fs-probe', 'host': MID, 'owner': 'cache-native-boundary', 'kind': 'preallocated-files', 'blockBytes': 4096,
     'maxBytes': (12 << 20) + slack, 'slackBytes': slack, 'files': files}
ledger = {'format': B.FORMAT, 'capBytes': B.CAP, 'targetBytes': B.TARGET,
          'hosts': [{'machineId': MID, 'label': 'host-fs-fixture', 'shareBytes': B.BOOKKEEPING_BYTES + r['maxBytes']}], 'reservations': [r]}
L = B.CANONICAL_PATH
os.makedirs(os.path.dirname(L), exist_ok=True)
Path(L).write_text(json.dumps(ledger)); os.chmod(L, 0o644)
out = {'fs': B.fs_of(str(D)), 'ledgerUidInNamespace': os.lstat(L).st_uid, 'maxBytes': r['maxBytes'], 'slack': slack}
run = lambda *a: subprocess.run([sys.executable, '-I', str(HERE.parent / 'vendor/holder/budget.py'), *a], capture_output=True, text=True)
p = run('admit', L, r['id'], f'{files[0]["path"]}={files[0]["bytes"]}', f'{files[1]["path"]}={files[1]["bytes"]}'); out['admit'] = [p.returncode, p.stdout.strip()]
v0 = os.statvfs(str(D)).f_bfree * 4096
p = run('allocate', L, r['id']); out['allocate'] = [p.returncode, p.stdout.strip().splitlines()]
v1 = os.statvfs(str(D)).f_bfree * 4096
out['actualBytes'] = B.actual_bytes(r)
out['perFile'] = {Path(f['path']).name: {'size': os.lstat(f['path']).st_size, 'allocated': os.lstat(f['path']).st_blocks * 512} for f in files}
out['freeDeltaNoisy'] = v0 - v1
p = run('verify', L, r['id']); out['verify'] = [p.returncode, json.loads(p.stdout) if p.returncode == 0 else p.stderr.strip()]
over = json.loads(json.dumps(ledger)); over['reservations'].append(dict(r, id='one-more', files=[{'path': str(D / 'x.img'), 'bytes': 4096}],
                                                                        slackBytes=B.required_headroom({'blockBytes': 4096, 'files': [{'path': str(D / 'x.img'), 'bytes': 4096}]})))
over['reservations'][1]['maxBytes'] = 4096 + over['reservations'][1]['slackBytes']
try:
    B.validate(over); out['nextRefused'] = None
except B.BudgetError as e:
    out['nextRefused'] = str(e)
os.truncate(files[1]['path'], (4 << 20) + 4096)
p = run('verify', L, r['id']); out['grownRefused'] = [p.returncode, p.stderr.strip()[-200:]]
os.truncate(files[1]['path'], 4 << 20)
for f in files:
    os.remove(f['path']); os.remove(f['path'] + B.MARKER)
os.rmdir(D)
out['ok'] = (out['admit'][0] == 0 and out['allocate'][0] == 0 and out['verify'][0] == 0 and out['actualBytes'] <= r['maxBytes']
             and bool(out['nextRefused']) and out['grownRefused'][0] == 3)
print(json.dumps(out, indent=1, default=str))
sys.exit(0 if out['ok'] else 1)
