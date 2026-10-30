from pathlib import Path
import subprocess,json,time,urllib.request
new='1da344346ffe01df7695059bf4c27a5ef48ea6dc5cad11f6893683c71e5933f7'
root='/opt/enclave-predict/release-1da34434'
b=Path('/var/lib/enclave-relay/retire-rollout-20261028-admission-before.json')
old=json.loads(b.read_text())['values'];keys=list(old)
def run(a):return subprocess.check_output(a,text=True,timeout=30).strip()
def values():
 pid=run(['systemctl','show','enclave-api-relay','-p','MainPID','--value'])
 e=dict(x.split('=',1) for x in Path('/proc/'+pid+'/environ').read_text().split('\0') if '=' in x)
 return {k:e[k] for k in keys}
expected={k:v+','+new+('='+root if k=='SECRETS_RELEASE_PREDICT_RELEASES' else '') for k,v in old.items()}
assert values()==expected,'effective lists changed; stop for reconciliation'
drop=Path('/etc/systemd/system/enclave-api-relay.service.d/zzzzzzzz-retire-budget-20261028.conf')
env=Path('/etc/nan-relay/retire-budget-release-20261028.env')
assert drop.read_text()=='[Service]\nEnvironmentFile='+str(env)+'\n'
assert env.read_text()==''.join(k+'='+v+'\n' for k,v in expected.items())
disabled=drop.with_suffix('.conf.disabled');assert not disabled.exists()
drop.rename(disabled)
try:
 run(['systemctl','daemon-reload']);run(['systemctl','restart','enclave-api-relay'])
 until=time.monotonic()+25
 while True:
  try:
   assert values()==old
   with urllib.request.urlopen('http://127.0.0.1:8100/health',timeout=3) as r:h=json.load(r)
   assert h.get('ok');break
  except Exception:
   if time.monotonic()>until:raise
   time.sleep(1)
 print(json.dumps({'failedReleaseRemovedFromAllThreeLists':new,'allPriorEntriesRestored':True,'health':h,'disabledDropin':str(disabled),'releaseFilesRetained':True}))
except BaseException:
 disabled.rename(drop);run(['systemctl','daemon-reload']);run(['systemctl','restart','enclave-api-relay']);assert values()==expected;raise
