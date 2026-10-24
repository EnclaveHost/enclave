from pathlib import Path
import subprocess,json,hashlib,datetime
ROOT=Path('/home/steven/Documents/Codex/2026-10-18/wo'); CK=ROOT/'work/source-checkpoint-20261022/main-repo'
def git(repo,*args):return subprocess.check_output(['git','-C',str(repo),*args])
def sha(b):return hashlib.sha256(b).hexdigest()
BASE='be1827eb87a0711ece16de6a5a13f3ca4e62d886'
OUT=CK/'checkpoints/decentralization-20261022/custody-signing-20261024-0205'
assert git(CK,'rev-parse','HEAD').decode().strip()==BASE
assert not git(CK,'status','--porcelain').strip()
assert not OUT.exists()
entries=[];sources=[]
def save(rel,b,origin):
 assert b'\0' not in b and len(b)<5_000_000;b.decode('utf8')
 assert (b'-----BEGIN '+b'PRIVATE KEY-----') not in b
 p=OUT/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b)
 entries.append({'path':str(rel),'sha256':sha(b),'bytes':len(b),'origin':origin})
for name,folder,head in [('canary','custody-v2-r2-production-canary-20261024','d1fc04dcaf6c9ebcfc9636f509307c2c2ddc0e8f'),('docs','custody-v2-current-docs-20261023',None),('factory-wallet','custody-factory-wallet-20261023','8b1357ec8f6039b79ffa0a0cf5f63bf9156c6e44'),('canary-wallet','custody-canary-wallet-20261023','f77e6a707903be3bcdeb9237366dce25d1cf9fc3')]:
 repo=ROOT/'work'/folder;actual=git(repo,'rev-parse','HEAD').decode().strip()
 if head:assert actual==head
 head=actual;sources.append({'name':name,'head':head,'repo':'work/'+folder})
 for rec in git(repo,'ls-tree','-rz',head).split(b'\0'):
  if not rec:continue
  hdr,path=rec.split(b'\t');mode,kind,oid=hdr.decode().split();path=path.decode()
  assert kind=='blob' and mode in ('100644','100755')
  assert not any(v in Path(path).parts for v in ('private','node_modules','runs','.git'))
  save(Path('sources')/name/path,git(repo,'cat-file','blob',oid),folder+'@'+head+':'+path)
for f in ['custody-v2-live-verification-20261023.md','custody-host-authority-20261024.json','custody-checkpoint-receipt-20261024.json','custody-protected-health-20261024.json']:
 save(Path('reports')/f,(ROOT/'outputs/decentralization-audit'/f).read_bytes(),'outputs/decentralization-audit/'+f)
for f in ['root-full-8.out','root-attestation-mutants-1.out','root-genesis-submit-1.out','root-attestation-1.out','root-read-steps-1.out']:
 save(Path('evidence')/f,(ROOT/'work/custody-v2-r2-production-canary-20261024/logs'/f).read_bytes(),'work/custody-v2-r2-production-canary-20261024/logs/'+f)
save(Path('capture.py'),Path(__file__).read_bytes(),str(Path(__file__).relative_to(ROOT)))
(OUT/'MANIFEST.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousCheckpoint':BASE,'sources':sources,'entries':entries,'status':'Source-only continuation; driver still unfinished; production custody lifecycle not run; pending maintenance approval; admin rights preserved'},indent=2)+'\n')
(OUT/'README.md').write_text('# Custody attestation and signing fixes\n\nExact source/evidence snapshots in MANIFEST.json. Canary harness:78 offline passes, one rollback-protection TODO,35 mutation controls detected. Still not an executable rollout kit. Wallet fixes: factory missing-result retry and RPC envelope validation; slower bounded canary storage upload and honest uncertain-state UI. Live two-provider factory preflight passed. Canary storage remains unverified; no administrator transaction is claimed. Original custody remains single-seat. Read sources/canary/STATUS.md and reports for remaining gates.\n')
print(json.dumps({'path':str(OUT),'files':len(entries),'sources':sources}))
