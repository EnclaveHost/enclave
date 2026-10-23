# PHASE 0 (ROOT EXECUTES after approving build.json): python3 work/custody-boot-activation-20261023/stage.py
# Copies ONLY the approved image dir into ~/enclave-prod/dist-leasegas-9f6d37bd8 (via .staging, then rename), re-verifying
# root's approval, the reviewed source commit, the build log and every file hash first. No release dir is staged
# (WorkingDirectory stays metal-deabf8f90: the launcher files are byte-identical). Never overwrites; deabf8f90's image stays
# the rollback, a6b1378cd's stays as it is. No config, drop-in or service is touched. Writes plan.json.
import json, shutil, os, sys
from common import *
os.umask(0o022)
rec, h = approved_build(A/'build.json', A/'APPROVED-BUILD.txt')
probs = source_problems()
log = Path(rec['buildLog']).read_bytes()
if sha(log) != rec['buildLogSha256']: probs.append('the build log changed since build.json')
again, p = build_problems(log.decode(), (RESTORE/'APPROVED-COMMIT.txt').read_text(), (REVIEWED['stage']/'INVENTORY.sha256').read_text(),
                          (REVIEWED['stage']/REVIEWED['name']/'MEASUREMENT').read_text())
probs += p
if again and {k: again[k] for k in again} != {k: rec[k] for k in again}: probs.append('the build no longer derives build.json')
src = Path(rec['stagedFrom']); dest = Path('/home/steven/enclave-prod')/REVIEWED['name']; tmp = dest.with_name(dest.name + '.staging')
if src != REVIEWED['stage']/REVIEWED['name']: probs.append('build.json names another staged dir')
probs += staged_problems(src, rec['files'])
if probs: sys.exit('REFUSED: ' + '; '.join(probs))
assert not (A/'plan.json').exists(), 'already staged: inspect'
assert not dest.exists() and not tmp.exists(), 'destination exists: inspect rather than overwrite'
for d in (CURRENT['dist'], CURRENT['workingDirectory']): assert Path(d).is_dir(), f'rollback target {d} missing'
shutil.copytree(src, tmp)
assert not staged_problems(tmp, rec['files']), 'the copy differs'
os.rename(tmp, dest)
plan = {'at': utc(), 'stage': 'image staged; no config or service changed', 'image': str(dest), 'measurement': rec['measurement'],
        'commit': rec['commit'], 'files': rec['files'], 'buildSha256': h, 'previousImage': CURRENT['dist'],
        'previousMeasurement': CURRENT['measurement'], 'workingDirectory': CURRENT['workingDirectory'], 'apps': {i: s['url'] for i, s in APPS.items()}}
(A/'plan.json').write_text(json.dumps(plan, indent=2) + '\n'); print(json.dumps(plan, indent=2))
