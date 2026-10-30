"""Install a versioned read-only diagnostic, then record a bounded live window. No service/config changes."""
import base64
import hashlib
import json
import pathlib
import subprocess

W = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo')
P = W / 'work/rpc-production-final-20261025'
O = pathlib.Path(__file__).resolve().parent
SHA = '9aa80ab8a2cbe156f513349f44366c4ad2c8588539666ac802ed9015c771d055'
source = P / 'source/ops/rpc-backend-bootstrap/2026-10-25/readiness/readiness_sampler.py'
review = json.loads((P / 'pruned-readiness-stage/logs/root-tests-2011-reviewed.json').read_text())
assert review['testBehavior'] == 'PASS' and review['suiteTests'] == 89 and len(review['mutants']) == 5
assert review['samplerSha256'] == SHA
assert hashlib.sha256((P / 'pruned-readiness-stage/logs/root-tests-2011.out').read_bytes()).hexdigest() == review['logSha256']
data = source.read_bytes()
assert hashlib.sha256(data).hexdigest() == SHA
ssh = ['ssh', '-F', '/home/steven/.local/state/enclave-rpc-production/ssh_config', 'enclave-rpc']
remote = '/opt/enclave-rpc/readiness/9aa80ab8a/readiness_sampler.py'
installer = '''import pathlib,base64,hashlib,json,os
p=pathlib.Path(%r)
b=base64.b64decode(%r)
assert hashlib.sha256(b).hexdigest()==%r
p.parent.mkdir(mode=0o755)
with p.open('xb') as f:
 f.write(b); f.flush(); os.fsync(f.fileno())
os.chmod(p,0o644)
assert hashlib.sha256(p.read_bytes()).hexdigest()==%r
print(json.dumps({'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'uid':p.stat().st_uid,'mode':oct(p.stat().st_mode & 0o777),'serviceChanges':False}))
''' % (remote, base64.b64encode(data).decode(), SHA, SHA)
r = subprocess.run(ssh + ['sudo -n python3 -'], input=installer, text=True, capture_output=True, timeout=30)
(O / 'install.out').write_text(r.stdout + r.stderr)
assert r.returncode == 0, r.stderr
assert json.loads(r.stdout)['uid'] == 0
with (O / 'window.out').open('x') as out:
 r = subprocess.run(ssh + ['python3', remote, '--out', '/tmp/enclave-rpc-readiness-9aa80ab8a-2014.json', '--samples', '7', '--interval', '120', '--min-window', '600', '--max-duration', '900', '--continue-on-fail'], stdout=out, stderr=subprocess.STDOUT, timeout=960)
(O / 'window.rc').write_text(str(r.returncode) + '\n')
print('Window complete, exit', r.returncode, '(0 READY, 3 FAIL, 4 INCOMPLETE)')
assert r.returncode in (0, 3, 4), r.returncode
r = subprocess.run(ssh + ['cat', '/tmp/enclave-rpc-readiness-9aa80ab8a-2014.json'], capture_output=True, timeout=30)
assert r.returncode == 0
(O / 'window.json').write_bytes(r.stdout)
