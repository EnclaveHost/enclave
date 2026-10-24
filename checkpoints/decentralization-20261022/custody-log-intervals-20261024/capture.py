from pathlib import Path
import subprocess,json,hashlib,datetime
root=Path('/home/steven/Documents/Codex/2026-10-18/wo');ck=root/'work/source-checkpoint-20261022/main-repo'
base='e5df789afd10ad02068ae951a460d8fe0223d549'
def git(p,*a):return subprocess.check_output(['git','-C',str(p),*a])
assert git(ck,'rev-parse','HEAD').decode().strip()==base and not git(ck,'status','--porcelain').strip()
out=ck/'checkpoints/decentralization-20261022/custody-log-intervals-20261024';assert not out.exists();entries=[]
def save(rel,b):
 b.decode('utf8');assert b'\0' not in b and len(b)<5000000;p=out/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);entries.append({'path':str(rel),'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)})
repo=root/'work/custody-v2-r2-production-canary-20261024';previous='5b44759'
previous=git(repo,'rev-parse',previous).decode().strip();head=git(repo,'rev-parse','HEAD').decode().strip()
changes=[]
for line in git(repo,'diff','--name-status',previous,head).decode().splitlines():
 status,name=line.split('\t');assert status in ['A','M'];changes.append({'status':status,'path':name});save(Path('sources/custody-v2-r2-production-canary-20261024')/name,git(repo,'show',head+':'+name))
save(Path('SOURCE-DELTA.json'),(json.dumps({'baseSnapshot':'../custody-recovery-generations-20261024/sources/custody-v2-r2-production-canary-20261024','baseCommit':previous,'commit':head,'changes':changes,'restore':'Copy the full base snapshot, then overlay every sources/custody-v2-r2-production-canary-20261024 file here. No tracked deletions.'},indent=2)+'\n').encode())
docs=root/'work/custody-v2-current-docs-20261023';dh=git(docs,'rev-parse','HEAD').decode().strip()
save(Path('docs/CURRENT-STATE.md'),git(docs,'show',dh+':CURRENT-STATE.md'));save(Path('docs/SOURCE-COMMIT.txt'),(dh+'\n').encode())
for name in ['root-full-25.out','root-log-window-full-2.guard','root-window-source-scan.guard','root-window-doc-scan.guard']:
 save(Path('tests')/name,(repo/'logs'/name).read_bytes())
for name in ['runtime-0531.json','host-0531.json','health-0531.json']:
 save(Path('reports')/name,(repo/'logs'/name).read_bytes())
save(Path('capture.py'),Path(__file__).read_bytes())
(out/'MANIFEST.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousCheckpoint':base,'entries':entries,'status':'Tested local custodian log intervals wired to the new committee release/refusal recorder. 156 Node/3 Python pass; known rollback TODO. Original apps healthy, host acceptance pending, insufficient free RAM for guarded canary launch. No production secret matrix or recipient lifecycle pass.'},indent=2)+'\n');print(json.dumps({'entries':len(entries),'sourceCommit':head,'snapshot':str(out)}))
