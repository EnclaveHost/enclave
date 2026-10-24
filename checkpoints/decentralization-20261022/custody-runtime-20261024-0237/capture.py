from pathlib import Path
import subprocess,json,hashlib,datetime
ROOT=Path('/home/steven/Documents/Codex/2026-10-18/wo'); CK=ROOT/'work/source-checkpoint-20261022/main-repo'
def git(repo,*args):return subprocess.check_output(['git','-C',str(repo),*args])
def sha(b):return hashlib.sha256(b).hexdigest()
BASE='30a5f867fe2c344845c5d8bed3316ec40a0280b3'
OUT=CK/'checkpoints/decentralization-20261022/custody-runtime-20261024-0237'
assert git(CK,'rev-parse','HEAD').decode().strip()==BASE
assert not git(CK,'status','--porcelain').strip()
assert not OUT.exists()
entries=[];sources=[]
def save(rel,b,origin):
 assert b'\0' not in b and len(b)<5_000_000;b.decode('utf8')
 assert (b'-----BEGIN '+b'PRIVATE KEY-----') not in b
 p=OUT/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b)
 entries.append({'path':str(rel),'sha256':sha(b),'bytes':len(b),'origin':origin})
for name,folder,head in [('canary','custody-v2-r2-production-canary-20261024','04b397641ebae4706fa6902d8edca8ece4e96591'),('docs','custody-v2-current-docs-20261023',None),('factory-wallet','custody-factory-wallet-20261023','8b1357ec8f6039b79ffa0a0cf5f63bf9156c6e44'),('canary-wallet','custody-canary-wallet-20261023','04d873fdb84ea424a32eb574e254a8ef82fba686')]:
 repo=ROOT/'work'/folder;actual=git(repo,'rev-parse','HEAD').decode().strip()
 if head:assert actual==head
 head=actual;sources.append({'name':name,'head':head,'repo':'work/'+folder})
 for rec in git(repo,'ls-tree','-rz',head).split(b'\0'):
  if not rec:continue
  hdr,path=rec.split(b'\t');mode,kind,oid=hdr.decode().split();path=path.decode()
  assert kind=='blob' and mode in ('100644','100755')
  assert not any(v in Path(path).parts for v in ('private','node_modules','runs','.git'))
  save(Path('sources')/name/path,git(repo,'cat-file','blob',oid),folder+'@'+head+':'+path)
for f in ['custody-v2-live-verification-20261023.md','custody-host-authority-20261024.json','custody-checkpoint-receipt-20261024.json','custody-protected-health-20261024.json','custody-factory-activation-20261024.json','custody-canary-storage-20261024.json','custody-runtime-baseline-20261024.json']:
 save(Path('reports')/f,(ROOT/'outputs/decentralization-audit'/f).read_bytes(),'outputs/decentralization-audit/'+f)
for f in ['root-full-11.out','root-runtime-mutants-1.out','root-runtime-baseline-1.out']:
 save(Path('evidence')/f,(ROOT/'work/custody-v2-r2-production-canary-20261024/logs'/f).read_bytes(),'work/custody-v2-r2-production-canary-20261024/logs/'+f)
save(Path('capture.py'),Path(__file__).read_bytes(),str(Path(__file__).relative_to(ROOT)))
(OUT/'MANIFEST.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousCheckpoint':BASE,'sources':sources,'entries':entries,'status':'Source-only continuation; driver still unfinished; production custody lifecycle not run; pending maintenance approval; admin rights preserved'},indent=2)+'\n')
(OUT/'README.md').write_text('# Custody runtime supervision source and evidence\n\nExact Git sources and public evidence in MANIFEST.json. New bounded launch/inspection/stop commands passed93 offline tests with one known rollback TODO;9 runtime mutation controls detected. Actual read-only Linux inventory confirmed4 running QEMU processes and protected services. No canary launch, committee creation, new secret or production lifecycle matrix occurred. Restricted ingress, fresh SNP launch gating, recovery/outage handlers and signing gates remain. Enclave admin rights are preserved; existing custody remains single-seat.\n')
print(json.dumps({'path':str(OUT),'files':len(entries),'sources':sources}))
