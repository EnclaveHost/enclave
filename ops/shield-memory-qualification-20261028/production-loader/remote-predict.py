from pathlib import Path
import subprocess,os,hashlib,json
P=Path('/tmp/enclave-loader-rollout-20261028')
work='/var/lib/enclave-relay/predict'
tc=work+'/toolchain-681a7e6e0964d8edead95521a953c11137361869'
tool='/opt/enclave-predict/829c09adb176/venv/bin/sev-snp-measure'
entry=Path(tool).resolve(); interpreter=entry.read_text().splitlines()[0][2:].strip().split()[0]
pkg=Path(subprocess.check_output([interpreter,'-c','import os,sevsnpmeasure;print(os.path.dirname(os.path.realpath(sevsnpmeasure.__file__)))'],text=True).strip())
lines=['entry\0'+hashlib.sha256(entry.read_bytes()).hexdigest()+'\n']
def walk(d,rel=''):
 for f in sorted(d.iterdir(),key=lambda f:f.name):
  if f.name=='__pycache__':continue
  q=rel+'/'+f.name if rel else f.name
  if f.is_dir():walk(f,q)
  elif f.is_file():lines.append(q+'\0'+hashlib.sha256(f.read_bytes()).hexdigest()+'\n')
walk(pkg)
assert hashlib.sha256(''.join(lines).encode()).hexdigest()=='b4e0a644f7b0304a239868d1563fd6e3fc4423e4534913dafa94e7e2b30bc142'
assert hashlib.file_digest(open(tc+'/isolation/m4/release-manifest.py','rb'),'sha256').hexdigest()=='6facdb9a77da31e6ddaf5a544f58a4966ea8dfdede87ad36e50818e22adbfd6b'
assert hashlib.file_digest((P/'app.bundle').open('rb'),'sha256').hexdigest()=='5bac47ac3b99d9999314ac3f5ee7c2749defdde98b2a52212302d05da13d58eb'
# Fresh prediction with the same independently pinned verifier toolchain, public bundle only.
env={'PATH':'/opt/enclave-predict/829c09adb176/go/bin:/usr/local/bin:/usr/bin:/bin','HOME':work+'/home','TMPDIR':str(P),'GOCACHE':str(P/'gocache'),'GOPATH':str(P/'gopath'),'GOTOOLCHAIN':'local','GOPROXY':'off','GOFLAGS':'-mod=readonly','LC_ALL':'C'}
a=['systemd-run','--unit=enclave-loader-predict-20261028','--wait','--pipe','--collect','-p','MemoryMax=2560M','-p','MemorySwapMax=0','-p','CPUQuota=100%','-p','RuntimeMaxSec=480']
for k,v in env.items():a+=['--setenv='+k+'='+v]
a+=['sh',tc+'/isolation/m4/expected-measurement.sh','--pin','af50d526be6deefcdd815968ff1dd2c04327f6c3b3f981c0aa90cc585b0effae','/opt/enclave-predict/release-af50d526',str(P/'app.bundle'),'16']
r=subprocess.run(a,capture_output=True,text=True,timeout=490)
(P/'prediction.out').write_text(r.stdout);(P/'prediction.err').write_text(r.stderr)
print(r.stdout);print(r.stderr);raise SystemExit(r.returncode)
