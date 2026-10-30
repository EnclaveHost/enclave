"""One bounded offline test attempt, requiring a separately reviewed admission."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time

p = Path(__file__).resolve().parent
assert os.sched_getaffinity(0) == {1}
admission = json.loads((p / 'ROOT-ADMISSION.json').read_text())
assert admission['status'] == 'FROZEN_SOURCE_REVIEWED_OFFLINE_TEST_ONLY'
inputs = admission['inputs']
assert all(Path(n).name == n for n in inputs)
assert {'maint_boot.py', 'guest_mask.py', 'test_root_maintenance.py',
        'test_root_transport_regressions.py', 'fixture-launcher.py',
        'fixture-manifest.json', 'harness.py'} <= set(inputs)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def check():
    for name, item in inputs.items():
        assert digest(Path(item['path'])) == item['sha256'], name
    assert digest(p / 'run.py') == admission['runnerSha256']

check()
with (p / 'ATTEMPT.json').open('x') as f:
    json.dump({'startedAt': time.time(), 'pid': os.getpid()}, f)
tmp = Path(tempfile.mkdtemp(prefix='qmp-root-offline-', dir=p))
(p / 'temp-dir.json').write_text(json.dumps({'path': str(tmp), 'owned': True}))
rc = 1
try:
    for name, item in inputs.items():
        shutil.copyfile(item['path'], tmp / name)
        assert digest(tmp / name) == item['sha256']
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(tmp), 'TMPDIR': str(tmp),
           'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONHASHSEED': '0'}
    with (p / 'test-output.txt').open('x') as out:
        r = subprocess.run(['/usr/bin/unshare', '-Urn', '/usr/bin/python3',
                            '-B', str(tmp / 'harness.py'), str(tmp),
                            str(p / 'RESULT.json')], cwd=tmp, env=env,
                           stdout=out, stderr=subprocess.STDOUT, timeout=180)
    rc = r.returncode
    for name, item in inputs.items():
        assert digest(tmp / name) == item['sha256'], name
    check()
finally:
    (p / 'remaining-test-files.json').write_text(json.dumps(
        [str(x.relative_to(tmp)) for x in tmp.rglob('*')]))
    shutil.rmtree(tmp)
    (p / 'result.rc').write_text(str(rc) + '\n')
raise SystemExit(rc)
