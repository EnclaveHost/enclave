"""Hosted Linux only. No VM, provider, network, package install or production import."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
import time

expected = os.environ['EXPECTED_SHA']
assert re.fullmatch('[0-9a-f]{40}', expected)
assert os.environ['GITHUB_SHA'] == expected
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == expected
root = Path('allocation-source').resolve()
out = Path('allocation-results').resolve()
root.mkdir()
out.mkdir()
files = json.loads(Path(__file__).with_name('source-files.json').read_text())
assert len(files) == 31 and len(set(files)) == len(files)
pins = {}
for name in files:
    assert re.fullmatch(r'[A-Za-z0-9_./-]+\.(mjs|json)', name) and '..' not in Path(name).parts
    data = subprocess.check_output(['git', 'show', expected + ':' + name])
    assert 0 < len(data) <= 131072
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    pins[name] = hashlib.sha256(data).hexdigest()
node = shutil.which('node')
assert node and Path(node).is_file()
(out / 'SOURCE.json').write_text(json.dumps({'head': expected, 'files': pins,
    'nodeVersion': subprocess.check_output([node, '--version'], text=True).strip(),
    'nodeSha256': hashlib.sha256(Path(node).read_bytes()).hexdigest()}, indent=2) + '\n')

# Hosted runner's own 2 GiB reserve; this is not a change to any production or
# local 27 GiB admission floor. The native test service is offline and read-only.
unit = 'rpc-manager-allocation-' + os.environ['GITHUB_RUN_ID']
command = ['sudo', 'systemd-run', '--wait', '--pipe', '--unit=' + unit,
    '--property=MemoryMax=512M', '--property=MemorySwapMax=0', '--property=CPUQuota=100%',
    '--property=RuntimeMaxSec=30', '--property=TimeoutStopSec=3', '--property=KillMode=control-group',
    '--property=PrivateNetwork=yes', '--property=NoNewPrivileges=yes',
    '--property=ProtectSystem=strict', '--property=ProtectHome=read-only',
    '--property=ReadWritePaths=' + str(out), '--property=WorkingDirectory=' + str(root),
    '--uid=' + str(os.getuid()), '--gid=' + str(os.getgid()),
    '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', node,
    str(root / 'test/helpers/memory-guard.mjs'), '--max-rss-mib', '450',
    '--floor-available-mib', '2048', '--log', str(out / 'memory.log'), '--',
    node, '--test', '--test-concurrency=1', '--test-timeout=5000',
    'windows/vbslike/manager/allocation-observation.test.mjs',
    'windows/vbslike/manager/physical-memory.test.mjs',
    'windows/vbslike/manager/memory-share.test.mjs',
    'windows/vbslike/manager/restart.test.mjs',
    'windows/vbslike/manager/shared-physical-reservations.test.mjs',
    'windows/vbslike/manager/physical-reservations.test.mjs']
(out / 'COMMAND.json').write_text(json.dumps(command, indent=2) + '\n')
began = time.monotonic()
with (out / 'tests.log').open('x') as log:
    run = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=45)
drift = [name for name, digest in pins.items() if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest]
(out / 'RESULT.json').write_text(json.dumps({'rc': run.returncode,
    'elapsedMs': round((time.monotonic() - began) * 1000), 'sourceDrift': drift,
    'scope': 'hosted-inert-manager-only', 'productionAdmission': False}, indent=2) + '\n')
print((out / 'tests.log').read_text())
assert not drift
raise SystemExit(run.returncode)
