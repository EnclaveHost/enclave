from pathlib import Path
import json,hashlib,os,shutil,datetime
W=Path('/home/steven/Documents/Codex/2026-10-18/wo');main=W/'work/enclave';worker=W/'work/host-relay-placement/tree';out=W/'work/host-relay-main-integration'
rows=[]
for l in (W/'work/host-relay-placement/host-relay-placement.inventory').read_text().splitlines():
 if not l.strip():continue
 after,before,path,*note=l.split();assert '..' not in Path(path).parts and not Path(path).is_absolute()
 rows.append({'path':path,'before':before,'after':after,'generated':bool(note)})
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else 'absent'
assert len(rows)==20
for r in rows:
 assert sha(main/r['path'])==r['before'],('main drift',r['path'])
 assert sha(worker/r['path'])==r['after'],('candidate drift',r['path'])
for r in rows:
 f=main/r['path'];s=worker/r['path'];b=out/'before'/r['path'];b.parent.mkdir(parents=True,exist_ok=True)
 if f.exists():assert not b.exists();shutil.copy2(f,b)
 f.parent.mkdir(parents=True,exist_ok=True);tmp=f.with_name(f.name+'.root-relay-tmp');assert not tmp.exists();shutil.copy2(s,tmp);os.replace(tmp,f)
for r in rows:assert sha(main/r['path'])==r['after']
d={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'integrated source and tested generated artifacts; final closure check pending','productionActivated':False,'paths':rows,'evidence':['work/host-relay-placement/logs/run4.out','work/host-relay-placement/logs/run5.out'],'pending':['Check generated bundle input closure against integrated main.','Non-DO host role activation, approved relay float migration/funding, public ingress and live app-paid failure proof.']}
(out/'inventory.json').write_text(json.dumps(d,indent=2)+'\n');(W/'outputs/decentralization-audit/host-relay-integration.json').write_text(json.dumps(d,indent=2)+'\n');print('Integrated20CAS-verified paths; no runtime changed.')
