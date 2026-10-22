from pathlib import Path
import subprocess,json,time,datetime
hosts=json.loads(Path('outputs/storage-tunnel-preparation.json').read_text()); report=[]
for row in hosts:
 host=row['host'];ip=row['address']
 pre=subprocess.run(['ssh','-o','BatchMode=yes',host,"curl -sS --max-time 15 --resolve sia.enclave.host:29443:127.0.0.1 https://sia.enclave.host:29443/ -o /dev/null -w '%{http_code}'"],capture_output=True,text=True)
 assert pre.returncode==0 and pre.stdout=='502',(host,'staged TLS route unavailable')
 script=r'''set -eu
systemctl show enclave-network-provider -p ExecStart --value | grep -qF '/etc/enclave-network/provider-pinned-8b37c37.json'
python3 - <<'INNER'
import json,shutil,os
from pathlib import Path
p=Path('/etc/enclave-network/provider-pinned-8b37c37.json'); b=p.with_name('provider-pinned-8b37c37.before-storage-20261019.json'); c=json.loads(p.read_text()); routes=c.setdefault('localRoutes',{}); expected={'host':'127.0.0.1','tls':29443,'http':29080}
if 'sia.enclave.host' in routes:
 assert routes['sia.enclave.host']==expected,'Existing Sia route differs'
else:
 assert not b.exists(),'Backup exists; inspect previous attempt'
 shutil.copy2(p,b); os.chmod(b,0o600)
 routes['sia.enclave.host']=expected
 t=p.with_suffix('.storage.tmp'); t.write_text(json.dumps(c,indent=2)+'\n');os.chmod(t,0o600);os.chown(t,p.stat().st_uid,p.stat().st_gid);os.replace(t,p)
INNER
systemctl restart enclave-network-provider
systemctl is-active --quiet enclave-network-provider
'''
 result=subprocess.run(['ssh','-o','BatchMode=yes',host,'sh -s'],input=script,capture_output=True,text=True)
 assert result.returncode==0,host+' provider restart failed'
 errors=[]
 for attempt in range(18):
  try:
   staged=subprocess.run(['curl','-sS','--max-time','10','--resolve','sia.enclave.host:443:'+ip,'https://sia.enclave.host/','-o','/dev/null','-w','%{http_code}'],capture_output=True,text=True)
   existing=subprocess.run(['curl','-sS','--max-time','10','--resolve','7ae476a3.app.enclave.host:443:'+ip,'https://7ae476a3.app.enclave.host/api/status'],capture_output=True,text=True)
   assert staged.returncode==0 and staged.stdout=='502'
   state=json.loads(existing.stdout); assert existing.returncode==0 and state['state']=='ready'
   break
  except Exception as e:
   if attempt==17: raise RuntimeError(host+' routing failed; stop rollout and inspect')
   time.sleep(5)
 report.append({'host':host,'publicAddress':ip,'newTLSRouteVerified':True,'stagedHTTPStatus':502,'existingAdapterReady':True,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()})
 Path('outputs/storage-ingress-verification.json').write_text(json.dumps(report,indent=2)+'\n')
 print(host+': staged TLS route verified; existing adapter ready',flush=True)
