"""Append only the verified loader release to the three existing release lists."""
from pathlib import Path
import subprocess,os,json,time,urllib.request,hashlib
NEW='af50d526be6deefcdd815968ff1dd2c04327f6c3b3f981c0aa90cc585b0effae'
OLD='5cab66e478a78adf69c5bb6f058117fcd91cddfb72ca3f6c5d47c109cc47ba17'
ROOT=Path('/opt/enclave-predict/release-af50d526')
P=Path('/tmp/enclave-loader-rollout-20261028')
keys=['SECRETS_RELEASE_PREDICT_RELEASES','SECRETS_RELEASE_DOMAIN_RELEASES','SECRETS_RELEASE_CERT_RELEASES']
def run(args):return subprocess.check_output(args,text=True,timeout=30).strip()
def pid():return run(['systemctl','show','enclave-api-relay','-p','MainPID','--value'])
def values(pid):
 e=dict(s.split('=',1) for s in Path('/proc/'+pid+'/environ').read_text().split('\0') if '=' in s)
 return {k:e[k] for k in keys}
pred=(P/'prediction.out').read_text()
assert 'release '+NEW+'\n' in pred and 'app_id 5bac47ac3b99d9999314ac3f5ee7c2749defdde98b2a52212302d05da13d58eb\n' in pred
assert any(l.startswith('measurement ') and len(l.split()[1])==96 for l in pred.splitlines())
assert hashlib.file_digest((P/'release-manifest.py').open('rb'),'sha256').hexdigest()=='6facdb9a77da31e6ddaf5a544f58a4966ea8dfdede87ad36e50818e22adbfd6b'
run(['python3',str(P/'release-manifest.py'),'verify',str(ROOT),'--expect',NEW])
# Modes only; the verified release consists entirely of root-owned public files.
run(['chmod','-R','a+rX,go-w',str(ROOT)])
oldpid=pid(); before=values(oldpid);uid=os.stat('/proc/'+oldpid).st_uid;gid=os.stat('/proc/'+oldpid).st_gid
# Export only the pinned public verifier tool; /tmp staging stays private.
publicTool=Path('/opt/enclave-predict/loader-manifest-20261028.py')
if publicTool.exists():assert publicTool.read_bytes()==(P/'release-manifest.py').read_bytes()
else:publicTool.write_bytes((P/'release-manifest.py').read_bytes());publicTool.chmod(0o644)
run(['setpriv','--reuid',str(uid),'--regid',str(gid),'--clear-groups','python3',str(publicTool),'verify',str(ROOT),'--expect',NEW])
after={}
for k in keys:
 arr=before[k].split(','); assert any(x==OLD or x.startswith(OLD+'=') for x in arr),k
 assert not any(x==NEW or x.startswith(NEW+'=') for x in arr),k
 after[k]=before[k]+','+NEW+('='+str(ROOT) if k==keys[0] else '')
backup=Path('/var/lib/enclave-relay/loader-rollout-20261028-admission-before.json')
if backup.exists():assert json.loads(backup.read_text())=={'pid':oldpid,'values':before}
else:backup.write_text(json.dumps({'pid':oldpid,'values':before},indent=2)+'\n');backup.chmod(0o600)
envf=Path('/etc/nan-relay/loader-cache-release-20261028.env')
drop=Path('/etc/systemd/system/enclave-api-relay.service.d/zzzzzzz-loader-cache-20261028.conf')
assert not envf.exists() and not drop.exists()
assert all(f.name<drop.name for f in drop.parent.glob('*.conf'))
assert pid()==oldpid and values(oldpid)==before
try:
 with envf.open('x') as f:f.write(''.join(k+'='+v+'\n' for k,v in after.items()))
 envf.chmod(0o600)
 with drop.open('x') as f:f.write('[Service]\nEnvironmentFile='+str(envf)+'\n')
 run(['systemctl','daemon-reload']);run(['systemctl','restart','enclave-api-relay'])
 until=time.monotonic()+30
 while True:
  try:
   newpid=pid();assert newpid!='0' and values(newpid)==after
   with urllib.request.urlopen('http://127.0.0.1:8100/health',timeout=3) as r:health=json.load(r)
   assert health.get('ok');break
  except Exception:
   if time.monotonic()>until:raise
   time.sleep(1)
 print(json.dumps({'newRelease':NEW,'pid':newpid,'priorEntriesPreserved':True,'health':health,'backup':str(backup)}))
except BaseException:
 # Remove only artifacts created by this invocation and restore prior effective lists.
 if drop.exists():drop.unlink()
 if envf.exists():envf.unlink()
 run(['systemctl','daemon-reload']);run(['systemctl','restart','enclave-api-relay'])
 assert values(pid())==before
 raise
