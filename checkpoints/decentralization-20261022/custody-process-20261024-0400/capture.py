from pathlib import Path
import subprocess,json,hashlib,datetime
ROOT=Path('/home/steven/Documents/Codex/2026-10-18/wo');CK=ROOT/'work/source-checkpoint-20261022/main-repo'
def git(repo,*args):return subprocess.check_output(['git','-C',str(repo),*args])
def sha(b):return hashlib.sha256(b).hexdigest()
BASE='13d32a4152dfdb5372e00eb5c3741eb6ef9cfd0c';OUT=CK/'checkpoints/decentralization-20261022/custody-process-20261024-0400'
assert git(CK,'rev-parse','HEAD').decode().strip()==BASE
assert not git(CK,'status','--porcelain').strip();assert not OUT.exists()
entries=[];sources=[]
def save(rel,b,origin):
 assert b'\0' not in b and len(b)<5000000;b.decode('utf8');assert (b'-----BEGIN '+b'PRIVATE KEY-----') not in b
 p=OUT/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);entries.append({'path':str(rel),'sha256':sha(b),'bytes':len(b),'origin':origin})
for name,folder,head in [('canary','custody-v2-r2-production-canary-20261024','3709f1033d7d87d01468b3d36035b1057ed7f142'),('forwarder','custody-v2-ingress-forwarder-20261023','5f364d4f9bd387370e79690df6d622e402d36645'),('reclaim','metal0-expired-recovery-20261024','f53bbc14b6073eb1d948538cc4431be65e1f1518')]:
 repo=ROOT/'work'/folder;assert git(repo,'rev-parse','HEAD').decode().strip()==head;assert not git(repo,'status','--porcelain','--untracked-files=no').strip();sources.append({'name':name,'head':head,'repo':'work/'+folder})
 for rec in git(repo,'ls-tree','-rz',head).split(b'\0'):
  if not rec:continue
  hdr,p=rec.split(b'\t');mode,kind,oid=hdr.decode().split();p=p.decode();assert kind=='blob' and mode in ('100644','100755');assert not any(v in Path(p).parts for v in ('private','node_modules','runs','.git'))
  save(Path('sources')/name/p,git(repo,'cat-file','blob',oid),folder+'@'+head+':'+p)
repo=ROOT/'work/custody-v2-live-20261023';head=git(repo,'rev-parse','HEAD').decode().strip();sources.append({'name':'diagnostic','head':head,'repo':'work/custody-v2-live-20261023','subset':True})
for p in ['probes/metal0-listing-status.mjs','evidence/boot-public-state.json']:save(Path('sources/diagnostic')/p,git(repo,'show',head+':'+p),'custody-v2-live-20261023@'+head+':'+p)
for p in ['custody-v2-live-verification-20261023.md','metal0-expired-recovery-proposal-20261024.md','metal0-keeper-ended-20261024.json']:
 save(Path('reports')/p,(ROOT/'outputs/decentralization-audit'/p).read_bytes(),'outputs/decentralization-audit/'+p)
for folder,p in [('custody-v2-r2-production-canary-20261024','root-full-18.out'),('custody-v2-r2-production-canary-20261024','root-process-mutants-1.out'),('metal0-expired-recovery-20261024','test-5.out'),('metal0-expired-recovery-20261024','mutations-3.out')]:
 save(Path('evidence')/p,(ROOT/'work'/folder/'logs'/p).read_bytes(),'work/'+folder+'/logs/'+p)
save(Path('sources/diagnostic/probes/legacy-challenge-shape.mjs'),(repo/'probes/legacy-challenge-shape.mjs').read_bytes(),'work/custody-v2-live-20261023/probes/legacy-challenge-shape.mjs')
save(Path('evidence/protected-guest-health.json'),(repo/'evidence/protected-guest-health.json').read_bytes(),'work/custody-v2-live-20261023/evidence/protected-guest-health.json')
save(Path('capture.py'),Path(__file__).read_bytes(),str(Path(__file__).relative_to(ROOT)))
(OUT/'MANIFEST.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousCheckpoint':BASE,'sources':sources,'entries':entries,'status':'Source-only canary process supervision and later-recipient preservation fixes. Full live custody lifecycle incomplete. Exhausted keeper naturally exited; no claims, funding, delegation or production service mutation. Approval pending; admin rights preserved.'},indent=2)+'\n')
print(json.dumps({'path':str(OUT),'files':len(entries),'sources':sources}))
