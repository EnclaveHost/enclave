from pathlib import Path
import subprocess,json,hashlib,datetime
root=Path('/home/steven/Documents/Codex/2026-10-18/wo');ck=root/'work/source-checkpoint-20261022/main-repo'
def git(p,*a):return subprocess.check_output(['git','-C',str(p),*a])
base='00ae2f522ce2d1b2d995a77d98e97648c1588264';assert git(ck,'rev-parse','HEAD').decode().strip()==base;assert not git(ck,'status','--porcelain').strip()
out=ck/'checkpoints/decentralization-20261022/metal0-approved-recovery-20261024';assert not out.exists();entries=[]
def save(name,data):
 data.decode('utf8');assert len(data)<5000000 and b'\0' not in data
 p=out/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data);entries.append({'path':str(name),'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)})
for name,folder in [('reclaim','metal0-expired-recovery-20261024'),('funding','custody-operator-funding-options-20261023')]:
 p=root/'work'/folder;assert not git(p,'status','--porcelain','--untracked-files=no').strip();head=git(p,'rev-parse','HEAD').decode().strip()
 for row in git(p,'ls-tree','-rz',head).split(b'\0'):
  if not row:continue
  meta,rel=row.split(b'\t');mode,kind,oid=meta.decode().split();rel=rel.decode();assert kind=='blob' and mode in ('100644','100755');assert not set(Path(rel).parts)&{'private','node_modules','.git'}
  save(Path('sources')/name/rel,git(p,'cat-file','blob',oid))
 save(Path('sources')/name/'SOURCE-COMMIT.txt',(head+'\n').encode())
for name in ['metal0-approved-claims-20261024.json','metal0-original-renewal-reconciliation-20261024.json']:
 save(Path('reports')/name,(root/'outputs/decentralization-audit'/name).read_bytes())
for name in ['approved-reconcile-tests.out','approved-reconcile-mutants.out']:
 save(Path('evidence')/name,(root/'work/metal0-expired-recovery-20261024/logs'/name).read_bytes())
save(Path('capture.py'),Path(__file__).read_bytes())
(out/'MANIFEST.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousCheckpoint':base,'entries':entries,'status':'Two approved original-app claims confirmed; operator funding and registration still pending. Admin controls preserved.'},indent=2)+'\n');print(json.dumps({'files':len(entries),'snapshot':str(out)}))
