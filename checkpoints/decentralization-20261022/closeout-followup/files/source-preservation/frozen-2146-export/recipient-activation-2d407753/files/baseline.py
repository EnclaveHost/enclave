"""Root read-only baseline for the image-only custody recipient repair. Never emits private config."""
from pathlib import Path
import sys,json,hashlib,datetime,urllib.request,subprocess
sys.path.insert(0,str(Path('work/linux-post-adoption-release/activation').resolve()))
import apphealth,guestrows
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True}
p=Path('/home/steven/Projects/enclave/metal/config.json');raw=p.read_bytes();c=json.loads(raw)
out['config']={'sha256':hashlib.sha256(raw).hexdigest(),'dist':c.get('dist'),'mode':c.get('mode'),'leaseGasConfigured':bool(c.get('leaseGas')),'leaseGasDigest':hashlib.sha256(json.dumps(c.get('leaseGas'),sort_keys=True).encode()).hexdigest()}
out['unit']=dict(l.split('=',1) for l in subprocess.check_output(['systemctl','--user','show','enclave-metal.service','-p','ActiveState','-p','SubState','-p','MainPID','-p','WorkingDirectory','-p','KillMode'],text=True).splitlines() if '=' in l)
out['dropins']=[{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(Path('/home/steven/.config/systemd/user/enclave-metal.service.d').glob('*.conf'))]
with urllib.request.urlopen('https://api.enclave.host/t/metal0/availability',timeout=15) as r:
 d=json.loads(r.read(1048576));assert r.status==200
held=d.get('instanceSweep',{}).get('held');assert isinstance(held,list)
out['held']=[{k:r.get(k) for k in ['id','vm','status','owned']} for r in held]
ids=sorted(set(r['id'].lower() for r in held if r.get('status')!='failed'))
out['baseline']=guestrows.baseline(held,ids)
apps=json.loads(Path('work/linux-post-adoption-release/activation/apps-health.json').read_text());out['health']={}
for i,s in apps.items():
 ok,detail=apphealth.check(s);out['health'][i]={'ok':ok,'detail':detail,'spec':s}
out['readyForPlan']=out['unit']['ActiveState']=='active' and all(r['ok'] for r in out['health'].values()) and set(apps)<=set(out['baseline'])
out['limits']=['Read-only baseline; no restart, config or admission change. Fresh lease and admission checks are still needed before activation.']
Path('work/custody-recipient-activation-20261023/evidence/baseline.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
if not out['readyForPlan']:raise SystemExit(1)
