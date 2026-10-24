from pathlib import Path
import subprocess,json,hashlib,datetime
ROOT=Path('/home/steven/Documents/Codex/2026-10-18/wo');CK=ROOT/'work/source-checkpoint-20261022/main-repo'
def git(repo,*args):return subprocess.check_output(['git','-C',str(repo),*args])
def sha(b):return hashlib.sha256(b).hexdigest()
BASE='a118395ef15003fba20ce3e09173f655e7761001';OUT=CK/'checkpoints/decentralization-20261022/metal0-status-20261024-0334'
assert git(CK,'rev-parse','HEAD').decode().strip()==BASE
assert not git(CK,'status','--porcelain').strip();assert not OUT.exists()
entries=[];sources=[]
def save(rel,b,origin):
 assert b'\0' not in b and len(b)<5000000;b.decode('utf8');assert (b'-----BEGIN '+b'PRIVATE KEY-----') not in b
 p=OUT/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);entries.append({'path':str(rel),'sha256':sha(b),'bytes':len(b),'origin':origin})
for name,folder,head in [('canary','custody-v2-r2-production-canary-20261024','4b74f559e87e6620d266d995d1d29d0666dec2e3'),('forwarder','custody-v2-ingress-forwarder-20261023','5f364d4f9bd387370e79690df6d622e402d36645')]:
 repo=ROOT/'work'/folder;assert git(repo,'rev-parse','HEAD').decode().strip()==head;assert not git(repo,'status','--porcelain','--untracked-files=no').strip();sources.append({'name':name,'head':head,'repo':'work/'+folder})
 for rec in git(repo,'ls-tree','-rz',head).split(b'\0'):
  if not rec:continue
  hdr,p=rec.split(b'\t');mode,kind,oid=hdr.decode().split();p=p.decode();assert kind=='blob' and mode in ('100644','100755');assert not any(v in Path(p).parts for v in ('private','node_modules','runs','.git'))
  save(Path('sources')/name/p,git(repo,'cat-file','blob',oid),folder+'@'+head+':'+p)
repo=ROOT/'work/custody-v2-live-20261023';head=git(repo,'rev-parse','HEAD').decode().strip();sources.append({'name':'diagnostic','head':head,'repo':'work/custody-v2-live-20261023','subset':True})
for p in ['probes/metal0-listing-status.mjs','evidence/boot-public-state.json']:save(Path('sources/diagnostic')/p,git(repo,'show',head+':'+p),'custody-v2-live-20261023@'+head+':'+p)
for p in ['metal0-listing-status-20261024.json','metal0-status-20261024-0334.md','metal0-transport-20261024-0334.json','custody-legacy-challenge-20261024.json']:
 save(Path('reports')/p,(ROOT/'outputs/decentralization-audit'/p).read_bytes(),'outputs/decentralization-audit/'+p)
for folder,p in [('custody-v2-r2-production-canary-20261024','root-full-15.out'),('custody-v2-r2-production-canary-20261024','root-old-probe-mutants-1.out'),('custody-v2-ingress-forwarder-20261023','root-origin-mutants-2.out')]:
 save(Path('evidence')/p,(ROOT/'work'/folder/'logs'/p).read_bytes(),'work/'+folder+'/logs/'+p)
save(Path('sources/diagnostic/probes/legacy-challenge-shape.mjs'),(repo/'probes/legacy-challenge-shape.mjs').read_bytes(),'work/custody-v2-live-20261023/probes/legacy-challenge-shape.mjs')
save(Path('evidence/protected-guest-health.json'),(repo/'evidence/protected-guest-health.json').read_bytes(),'work/custody-v2-live-20261023/evidence/protected-guest-health.json')
save(Path('capture.py'),Path(__file__).read_bytes(),str(Path(__file__).relative_to(ROOT)))
(OUT/'MANIFEST.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousCheckpoint':BASE,'sources':sources,'entries':entries,'status':'Source-only custody probe fixes; live metal0 proof mismatch, exhausted lease window and transport failures; no production mutations; admin rights preserved'},indent=2)+'\n')
print(json.dumps({'path':str(OUT),'files':len(entries),'sources':sources}))
