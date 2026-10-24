from pathlib import Path
import subprocess,json,hashlib,datetime
ROOT=Path('/home/steven/Documents/Codex/2026-10-18/wo'); CK=ROOT/'work/source-checkpoint-20261022/main-repo'
def git(repo,*args):return subprocess.check_output(['git','-C',str(repo),*args])
def sha(b):return hashlib.sha256(b).hexdigest()
BASE='1457f65fc7c320160625315c2701f2144df5fbf8'
OUT=CK/'checkpoints/decentralization-20261022/custody-capture-20261024-0138'
assert git(CK,'rev-parse','HEAD').decode().strip()==BASE
assert not git(CK,'status','--porcelain').strip()
assert not OUT.exists()
entries=[];sources=[]
def save(rel,b,origin):
 assert b'\0' not in b and len(b)<5_000_000;b.decode('utf8')
 assert (b'-----BEGIN '+b'PRIVATE KEY-----') not in b
 p=OUT/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b)
 entries.append({'path':str(rel),'sha256':sha(b),'bytes':len(b),'origin':origin})
for name,folder,head in [('canary','custody-v2-r2-production-canary-20261024','6c9ad6b20ab99253b0545a4452b9f6d22d5fa844'),('docs','custody-v2-current-docs-20261023',None)]:
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
for f in ['root-full-7.out','root-capture-sender-mutants-1.out','root-capture-sender-mutants-2.out','root-capture-1.out','root-sender-2.out','root-preserve-3.out']:
 save(Path('evidence')/f,(ROOT/'work/custody-v2-r2-production-canary-20261024/logs'/f).read_bytes(),'work/custody-v2-r2-production-canary-20261024/logs/'+f)
save(Path('capture.py'),Path(__file__).read_bytes(),str(Path(__file__).relative_to(ROOT)))
(OUT/'MANIFEST.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousCheckpoint':BASE,'sources':sources,'entries':entries,'status':'Source-only continuation; driver still unfinished; production custody lifecycle not run; pending maintenance approval; admin rights preserved'},indent=2)+'\n')
(OUT/'README.md').write_text('# Custody capture and bounded sender continuation\n\nExact source/evidence snapshots in MANIFEST.json.64 offline tests pass, one rollback-protection TODO remains,27 mutation controls detected. The first mutation run failed due to fake-chain polling and is preserved with its corrected rerun. Capture-only host source transformation has not been launched. Full genesis/quote/CLI integration and production custody lifecycle remain unfinished. Original service/policies unchanged. Two protected tenants passed fresh HTTPS health at01:33:35UTC. Operator maintenance approval and later administrator signatures remain pending. Temporary keeper has an eight-renewal cap per app and outer cutoff03:53:51UTC; cap may stop it earlier. Read sources/canary/STATUS.md: this scaffold must not execute against production.\n')
print(json.dumps({'path':str(OUT),'files':len(entries),'sources':sources}))
