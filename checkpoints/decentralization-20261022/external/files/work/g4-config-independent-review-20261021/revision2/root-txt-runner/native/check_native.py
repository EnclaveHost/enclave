"""Temporary Windows package/config validation only. No live-file writes, task changes, or service starts.
Default: local plan. --execute stages exact public files, runs check-only commands, and removes its own stage.
"""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent
WORK = HERE.parents[3]
TRANSPORT = WORK / 'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(TRANSPORT.read_bytes()).hexdigest() == 'c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
spec = importlib.util.spec_from_file_location('transport', TRANSPORT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
q = lambda s: "'" + str(s).replace("'", "''") + "'"
R = HERE.parent
MERGE = R.parent / 'root-txt-merge'
FILES = {
    'check.ps1': HERE / 'check.ps1',
    'host-services-runner.mjs': R / 'artifacts/host-services-runner.mjs',
    'stage-tool.mjs': R / 'artifacts/stage-tool.mjs',
    'packages/route-dns.mjs': MERGE / 'artifacts/route-dns.mjs',
    'packages/route-dns.package.json': MERGE / 'artifacts/route-dns.package.json',
    'config.json': MERGE / 'host-services.parallel-txt.draft.json',
}
EXPECTED = {
    'host-services-runner.mjs': 'aca07ce30666304b87e3dc82380e7b28e4c26c2599bda0b06bc9cddd15393da8',
    'stage-tool.mjs': '3adc1ee17e4d03565b944d8d1b94e88ec0575c4eeaaad0ceb37a444c897333e8',
    'packages/route-dns.mjs': '23051f3377465335d0f00edbdf007f8aa486eafafd6e8f6332b33a08c0458f71',
    'packages/route-dns.package.json': '8a654c0da8ddf3e377db5a564195cb1638a31597ef9bf261c5508a6b1d389b6b',
}
for f, h in EXPECTED.items():
    assert sha(FILES[f]) == h, f
live = json.loads((WORK / 'challenge-host-tls-20261021/g4/upgrade-bundle-g4/upgrade-manifest.json').read_text())
LIVE = {p['path']: p['new'] for p in live['replace'] if p['path'].startswith(('bin/', 'packages/'))}
LIVE.update({p['path']: p['sha'] for p in live['unchanged'] if p['path'].startswith(('bin/', 'packages/'))})
upload = {name.replace('/', '\\'): sha(file) for name, file in FILES.items()}
pins = {'upload': upload, 'live': LIVE}
if sys.argv[1:] != ['--execute']:
    if sys.argv[1:]:
        raise SystemExit('usage: check_native.py [--execute]')
    print(json.dumps({'mode': 'plan-only', 'upload': upload, 'livePins': len(LIVE)}, indent=2))
    raise SystemExit(0)

stage = r'C:\ProgramData\Enclave\staging\txt-merge-check-' + uuid.uuid4().hex[:12]
result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'stage': stage, 'upload': upload, 'livePins': LIVE}
with (HERE / 'attempt.json').open('x') as f:
    json.dump(result, f, indent=2)
(HERE / 'pins.json').write_text(json.dumps(pins, indent=2) + '\n')
created = False
try:
    text = f"$s={q(stage)};if(Test-Path -LiteralPath $s){{throw 'stage exists'}};$null=New-Item -ItemType Directory -Path $s;$null=New-Item -ItemType Directory -Path ($s+'\\packages');@{{created=$s}}|ConvertTo-Json -Compress"
    result['create'] = m.ps(text, 60)
    created = result['create'].get('created') == stage
    if not created:
        raise RuntimeError('stage creation unconfirmed; inspect receipt')
    for name, file in {**FILES, 'pins.json': HERE / 'pins.json'}.items():
        dst = stage + '\\' + name.replace('/', '\\')
        p = subprocess.run(['timeout', '90', 'scp', '-q', '-o', 'BatchMode=yes', str(file), 'minipc:/' + dst.replace('\\', '/')], capture_output=True, text=True)
        if p.returncode:
            raise RuntimeError('upload failed: ' + name + ': ' + p.stderr[-200:])
    script_hash, pins_hash = sha(FILES['check.ps1']), sha(HERE / 'pins.json')
    text = f"$s={q(stage)};if((FileSha ($s+'\\check.ps1')) -ne '{script_hash}' -or (FileSha ($s+'\\pins.json')) -ne '{pins_hash}'){{throw 'check/pins mismatch'}};& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ($s+'\\check.ps1') -Stage $s;if($LASTEXITCODE -ne 0){{exit $LASTEXITCODE}}"
    result['validation'] = m.ps(text, 150)
    v = result['validation']
    result['ok'] = 'error' not in v and v.get('liveHashesUnchanged') is True and v.get('taskState') == 'Running' and len(v.get('checks', {})) == 6 and all(x is True for x in v.get('checks', {}).values())
except Exception as error:
    result['ok'] = False
    result['error'] = str(error)
finally:
    if created:
        result['cleanup'] = m.ps(f"$s={q(stage)};if($s -notmatch '^C:\\\\ProgramData\\\\Enclave\\\\staging\\\\txt-merge-check-[0-9a-f]{{12}}$'){{throw 'bad stage'}};Remove-Item -LiteralPath $s -Recurse -Force;@{{gone=(-not(Test-Path -LiteralPath $s))}}|ConvertTo-Json -Compress", 60)
        result['ok'] = result.get('ok', False) and result['cleanup'].get('gone') is True
    (HERE / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
raise SystemExit(0 if result.get('ok') else 1)
