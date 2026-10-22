from pathlib import Path
import subprocess,json,hashlib,time,sys,datetime
source=Path('work/enclave/network/bootstrap-gateway.mjs').read_bytes();old=Path('work/logo-original-server.mjs').read_bytes()
sha=hashlib.sha256(source).hexdigest();oldsha=hashlib.sha256(old).hexdigest()
remote=r'''
from pathlib import Path
import hashlib,subprocess,time,urllib.request,json,os
p=Path('/opt/enclave-retained/cc96aad/server.mjs');new=Path('/tmp/enclave-bootstrap-media.mjs')
assert hashlib.sha256(new.read_bytes()).hexdigest()==SHA
current=hashlib.sha256(p.read_bytes()).hexdigest();assert current in [OLD,SHA], 'unexpected live source'
backup=p.with_name('server.before-media.mjs')
if current!=SHA:
 assert not backup.exists() or hashlib.sha256(backup.read_bytes()).hexdigest()==OLD
 if not backup.exists():backup.write_bytes(p.read_bytes())
 os.replace(new,p)
 subprocess.run(['systemctl','restart','enclave-bootstrap-gateway'],check=True)
try:
 for attempt in range(300):
  try:
   with urllib.request.urlopen('http://127.0.0.1:8189/ipfs/bafkreibmpwj6te3ga36uvfuk7ft3jisqbifi4cganljw2ly5ejcxcmwaxy?filename=i.svg',timeout=3) as r:
    body=r.read();assert r.headers['Content-Type']=='image/svg+xml';assert hashlib.sha256(body).hexdigest()==BODY
   break
  except Exception:
   if attempt==299:raise
   time.sleep(1)
except BaseException:
 if current!=SHA:p.write_bytes(backup.read_bytes());subprocess.run(['systemctl','restart','enclave-bootstrap-gateway'],check=True)
 raise
print(json.dumps({'sourceSha256':SHA,'contentType':'image/svg+xml','bodySha256':BODY,'rollback':str(backup)}))
'''
report=json.loads(Path('outputs/logo-gateway-fix.json').read_text())['replicas'] if Path('outputs/logo-gateway-fix.json').exists() else []
for host in sys.argv[1:] or ['us-west','eu-central','ap-southeast','ca-east']:
 subprocess.run(['scp','-q','work/enclave/network/bootstrap-gateway.mjs',host+':/tmp/enclave-bootstrap-media.mjs'],check=True)
 r=subprocess.run(['ssh',host,'python3','-'],input='SHA='+repr(sha)+'\nOLD='+repr(oldsha)+'\nBODY='+repr(hashlib.sha256(Path('work/logo-body.svg').read_bytes()).hexdigest())+'\n'+remote,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(host+': '+r.stderr[-1000:])
 entry={'region':host,**json.loads(r.stdout)};report.append(entry);print(json.dumps(entry),flush=True)
 Path('outputs/logo-gateway-fix.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'commit':'58bd1550','replicas':report},indent=2)+'\n')
