from pathlib import Path
import subprocess,json,urllib.request,time,hashlib,datetime,sys
root=Path('/home/steven/Documents/Codex/2026-10-18/wo');release='8b37c37';name,ip=sys.argv[1:3];target='root@'+ip
bundle=root/'outputs/network-authority-release/provider.mjs';sha=hashlib.sha256(bundle.read_bytes()).hexdigest();pins=json.loads((root/'outputs/network-authority-release/authority-pins.json').read_text())
opts=['-o','BatchMode=yes','-o','ControlMaster=auto','-o','ControlPersist=60','-o','ControlPath='+str(root/'work/ssh-%h-%p')]
def ssh(script):return subprocess.check_output(['ssh',*opts,target,'bash','-s'],input=script,text=True,timeout=45)
def get(url):
 with urllib.request.urlopen(url,timeout=25) as r:return json.load(r)
def guest():
 r=subprocess.run(['curl','--fail','--silent','--show-error','--max-time','15','https://7ae476a3.app.enclave.host/api/status'],capture_output=True,text=True,timeout=20)
 if r.returncode:raise RuntimeError('adapter HTTPS check failed: '+r.stderr[:180])
 s=json.loads(r.stdout)
 if s.get('state')!='ready' or s.get('files')!=1239 or s.get('missing'):raise RuntimeError('adapter inventory is not ready')
 return {k:s[k] for k in ['state','files','rootCid']}
previous=ssh('systemctl show enclave-network-provider --property=ExecStart --property=ActiveState --property=MainPID')
assert 'ActiveState=active' in previous and any('/nan-retirement-'+v+'/wg-provider.mjs' in previous for v in ['272e830',release]),'unexpected running provider'
info=get('http://'+ip+':51822/v1/info');before_routes=get('http://'+ip+':8188/v1/network/routes');assert len(before_routes['deployments'])>=12
before_guest=guest()
subprocess.run(['scp','-q',*opts,str(bundle),target+':/tmp/wg-provider-'+release+'.mjs'],check=True,timeout=45)
install=r'''set -eu
umask 077
install -d -m 0755 /opt/enclave-network/nan-retirement-RELEASE /etc/systemd/system/enclave-network-provider.service.d
install -m 0644 /tmp/wg-provider-RELEASE.mjs /opt/enclave-network/nan-retirement-RELEASE/wg-provider.mjs
python3 - <<'REMOTE'
from pathlib import Path
import json
c=json.loads(Path('/etc/enclave-network/provider.json').read_text());c['authorityPins']=PINS
if len(c.get('directories',[]))!=4 or any('enclave.host' in x or '62.238.4.214' in x for x in c['directories']):raise RuntimeError('unexpected directory origins')
p=Path('/etc/enclave-network/provider-pinned-RELEASE.json');p.write_text(json.dumps(c,indent=2)+'\n');p.chmod(0o600)
p=Path('/etc/systemd/system/enclave-network-provider.service.d/zz-authority-pins.conf')
value='[Service]\nExecStart=\nExecStart=/usr/local/bin/node /opt/enclave-network/nan-retirement-RELEASE/wg-provider.mjs /etc/enclave-network/provider-pinned-RELEASE.json\n'
if p.exists() and p.read_text()!=value:raise RuntimeError('unexpected existing override')
p.write_text(value);p.chmod(0o644)
REMOTE
systemctl daemon-reload
systemctl restart enclave-network-provider
systemctl is-active enclave-network-provider
'''.replace('RELEASE',release).replace('PINS',repr(pins))
started=time.monotonic();attempts=[]
try:
 ssh(install)
 for n in range(20):
  try:
   after=get('http://'+ip+':51822/v1/info');routes=get('http://'+ip+':8188/v1/network/routes');s=guest()
   assert after['keys']==info['keys'],'WireGuard keys changed'
   assert len(routes['deployments'])>=12,'routes missing'
   systemd=ssh('systemctl show enclave-network-provider --property=ActiveState --property=NRestarts --property=ExecStart --property=MainPID\nsha256sum /opt/enclave-network/nan-retirement-'+release+'/wg-provider.mjs')
   assert 'ActiveState=active' in systemd and '/provider-pinned-'+release+'.json' in systemd and sha in systemd
   break
  except Exception as e:
   attempts.append({'atSeconds':round(time.monotonic()-started,1),'error':str(e)[:240]});time.sleep(3)
 else:raise RuntimeError('provider did not recover all validation gates')
 result={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':name,'address':ip,'release':release,'bundleSha256':sha,'authorityPins':pins,'before':info['status'],'after':after['status'],'routes':len(routes['deployments']),'guest':s,'secondsToValidation':round(time.monotonic()-started,1),'transientFailures':attempts,'systemd':systemd.strip(),'scope':'Provider authority pins only; custom-domain bridge and host privacy agents remain separate dependencies.'}
 p=root/'outputs/provider-pins-rollout.json';report=json.loads(p.read_text()) if p.exists() else {'providers':[]}
 report['providers']=[r for r in report['providers'] if r['host']!=name]+[result];report['status']='complete' if len(report['providers'])==4 else 'rolling out';p.write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(result))
except Exception:
 ssh("if grep -qF '/nan-retirement-"+release+"/wg-provider.mjs' /etc/systemd/system/enclave-network-provider.service.d/zz-authority-pins.conf; then rm /etc/systemd/system/enclave-network-provider.service.d/zz-authority-pins.conf; systemctl daemon-reload; systemctl restart enclave-network-provider; fi")
 raise
