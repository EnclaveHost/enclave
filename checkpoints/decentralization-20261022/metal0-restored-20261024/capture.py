from pathlib import Path
import subprocess,json,hashlib,datetime
root=Path('/home/steven/Documents/Codex/2026-10-18/wo');ck=root/'work/source-checkpoint-20261022/main-repo';base='80f07aea22f40db77ff0182673b259251b659ac9'
def git(p,*args):return subprocess.check_output(['git','-C',str(p),*args])
assert git(ck,'rev-parse','HEAD').decode().strip()==base and not git(ck,'status','--porcelain').strip()
out=ck/'checkpoints/decentralization-20261022/metal0-restored-20261024';assert not out.exists();entries=[]
def save(rel,b):
 b.decode('utf8');assert b'\0' not in b and len(b)<5000000;p=out/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);entries.append({'path':str(rel),'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)})
for folder,names in [('metal0-expired-recovery-20261024',['original-startup-fees.mjs','watch-normal-renewals.mjs']),('custody-operator-funding-options-20261023',['README.md'])]:
 repo=root/'work'/folder;head=git(repo,'rev-parse','HEAD').decode().strip()
 for name in names:save(Path('sources')/folder/name,git(repo,'show',head+':'+name))
 save(Path('sources')/folder/'SOURCE-COMMIT.txt',(head+'\n').encode())
for name in ['metal0-approved-claims-20261024.json','metal0-approved-funding-20261024.json','metal0-original-startup-budget-20261024.json','metal0-public-recovery-20261024.json','metal0-adoption-20261024.json','metal0-live-listing-20261024.json','metal0-normal-renewals-20261024.json','metal0-listing-status-20261024.json','metal0-expired-recovery-proposal-20261024.md']:
 save(Path('reports')/name,(root/'outputs/decentralization-audit'/name).read_bytes())
save(Path('capture.py'),Path(__file__).read_bytes())
(out/'MANIFEST.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousCheckpoint':base,'entries':entries,'status':'Approved funding/restoration verified; original control running, public apps healthy, original VMs adopted, Metal0 listed. Normal renewals still under observation. No custody activation or candidate cutover.'},indent=2)+'\n');print(json.dumps({'entries':len(entries),'snapshot':str(out)}))
