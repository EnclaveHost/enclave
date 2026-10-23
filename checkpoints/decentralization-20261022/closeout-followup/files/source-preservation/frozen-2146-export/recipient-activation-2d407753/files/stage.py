# PHASE 0 (ROOT EXECUTES): python3 work/custody-recipient-activation-20261023/stage.py
# Copies ONLY the candidate image dir into ~/enclave-prod/dist-leasegas-a6b1378cd (via a .staging dir, then rename), each
# file compared with the exact reviewed hashes (restore stage/INVENTORY.sha256). No release dir is staged: WorkingDirectory
# stays metal-deabf8f90 (the launcher files are byte-identical). Never overwrites; deabf8f90's image and release stay as the
# rollback. No config, drop-in or service is touched. Writes plan.json.
import json, shutil, os
from common import *
os.umask(0o022)
src, dest = NEW['staged'], Path(NEW['dist']); tmp = dest.with_name(dest.name + '.staging')
assert not (A/'plan.json').exists(), 'already staged: inspect'
assert not dest.exists() and not tmp.exists(), 'destination exists: inspect rather than overwrite'
for d in (CURRENT['dist'], CURRENT['workingDirectory']): assert Path(d).is_dir(), f'rollback target {d} missing'
files = sorted(p.name for p in src.iterdir())
assert files == sorted(NEW['files']), files
for f, h in NEW['files'].items(): assert sha((src/f).read_bytes()) == h, f'staged {f} changed'
assert (src/'MEASUREMENT').read_text().strip() == NEW['measurement']
shutil.copytree(src, tmp)
for f, h in NEW['files'].items(): assert sha((tmp/f).read_bytes()) == h, f'copy of {f} differs'
os.rename(tmp, dest)
plan = {'at': utc(), 'stage': 'image staged; no config or service changed', 'image': NEW['dist'], 'measurement': NEW['measurement'],
        'commit': NEW['commit'], 'files': NEW['files'], 'previousImage': CURRENT['dist'], 'previousMeasurement': CURRENT['measurement'],
        'workingDirectory': CURRENT['workingDirectory'], 'apps': {i: s['url'] for i, s in APPS.items()}}
(A/'plan.json').write_text(json.dumps(plan, indent=2) + '\n'); print(json.dumps(plan, indent=2))
