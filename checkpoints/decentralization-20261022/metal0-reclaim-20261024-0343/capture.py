from pathlib import Path
import subprocess,json,hashlib,datetime
ROOT=Path('/home/steven/Documents/Codex/2026-10-18/wo');CK=ROOT/'work/source-checkpoint-20261022/main-repo';R=ROOT/'work/metal0-expired-recovery-20261024'
def git(r,*a):return subprocess.check_output(['git','-C',str(r),*a])
BASE='c30f23b23033e934a8fd7673db6a25ea170c1f9c';HEAD='70004c8b81340233371f603667e4c31c4239839b';OUT=CK/'checkpoints/decentralization-20261022/metal0-reclaim-20261024-0343'
assert git(CK,'rev-parse','HEAD').decode().strip()==BASE and not git(CK,'status','--porcelain').strip();assert git(R,'rev-parse','HEAD').decode().strip()==HEAD and not git(R,'status','--porcelain','--untracked-files=no').strip();assert not OUT.exists();entries=[]
def save(rel,b,origin):
 assert b'\0' not in b and len(b)<1000000;b.decode();p=OUT/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);entries.append({'path':rel,'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'origin':origin})
for rec in git(R,'ls-tree','-rz',HEAD).split(b'\0'):
 if not rec:continue
 hdr,p=rec.split(b'\t');mode,kind,oid=hdr.decode().split();p=p.decode();assert kind=='blob' and mode in ('100644','100755') and not any(x in Path(p).parts for x in ('private','node_modules','.git'))
 save('source/'+p,git(R,'cat-file','blob',oid),'work/metal0-expired-recovery-20261024@'+HEAD+':'+p)
for p in ['test-3.out','mutations-2.out']:save('evidence/'+p,(R/'logs'/p).read_bytes(),'work/metal0-expired-recovery-20261024/logs/'+p)
for p in ['metal0-expired-recovery-proposal-20261024.md','metal0-expired-claim-status-20261024.json','metal0-local-app-health-20261024.json']:save('reports/'+p,(ROOT/'outputs/decentralization-audit'/p).read_bytes(),'outputs/decentralization-audit/'+p)
save('capture.py',Path(__file__).read_bytes(),'work/resume-after-checkpoint-20261022/source-preservation/capture-reclaim-0343.py')
(OUT/'MANIFEST.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousCheckpoint':BASE,'source':HEAD,'entries':entries,'status':'Prepared finite expired-lease reclaims; human approval pending. No claims, signing, funding, delegation or service changes. Original keeper cap and journal unchanged; no private approval exists. Live original app health passed over strict loopback TLS; public recovery still incomplete.'},indent=2)+'\n');print(json.dumps({'files':len(entries),'path':str(OUT)}))
