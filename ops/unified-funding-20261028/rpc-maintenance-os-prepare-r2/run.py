from pathlib import Path
import hashlib
import json
import os
import subprocess
import time

p = Path(__file__).resolve().parent
assert os.sched_getaffinity(0) == {1}
pins = json.loads((p / 'INPUT-PINS.json').read_text())
def check():
    for name, sha in pins.items():
        assert hashlib.sha256((p / name).read_bytes()).hexdigest() == sha, name
check()
with (p / 'ATTEMPT.json').open('x') as f:
    json.dump({'startedAt': time.time(), 'action': 'prepare new verified OS backup only'}, f)
env = {'PATH': '/usr/bin:/bin', 'HOME': '/home/steven',
       'XDG_RUNTIME_DIR': '/run/user/1000',
       'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/1000/bus',
       'PYTHONDONTWRITEBYTECODE': '1'}
with (p / 'prepare-output.json').open('x') as out:
    r = subprocess.run(['/usr/bin/python3', '-I', '-B', str(p / 'maint_boot.py'),
                        'prepare', '--evidence', str(p / 'evidence')],
                       cwd=p, env=env, stdout=out, stderr=subprocess.STDOUT, timeout=2600)
check()
(p / 'result.rc').write_text(str(r.returncode) + '\n')
raise SystemExit(r.returncode)
