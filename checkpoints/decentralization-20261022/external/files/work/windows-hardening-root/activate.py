from pathlib import Path
import subprocess, base64, json, datetime

base = Path(__file__).resolve().parent
root = base.parents[1]
stage = r'C:\ProgramData\Enclave\activation-stage\hardening-fb926d42'
record = base / 'activation-start.json'
assert not record.exists(), 'Already attempted: inspect status, never automatically repeat.'
with record.open('x') as f:
    json.dump({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'stage': stage, 'status': 'requested; outcome pending'}, f, indent=2)
script = r'''$ProgressPreference='SilentlyContinue'; & powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\ProgramData\Enclave\activation-stage\hardening-fb926d42\20-activate.ps1' -Reviewed; exit $LASTEXITCODE'''
with (root / 'outputs/app-lease-gas-review/windows-hardening-activation.txt').open('w') as out:
    proc = subprocess.Popen(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=15', 'minipc', 'powershell', '-NoProfile',
        '-EncodedCommand', base64.b64encode(script.encode('utf-16le')).decode()],
        stdout=out, stderr=subprocess.STDOUT)
    rc = proc.wait()
(base / 'activation-exit.json').write_text(json.dumps({
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exitCode': rc,
    'rule': '0 observed; any other code inspect status before further mutation.'}, indent=2)+'\n')
print('Windows hardening activation exit', rc)
raise SystemExit(rc)
