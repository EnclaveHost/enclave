from pathlib import Path
import subprocess,json,hashlib,datetime
root=Path('/home/steven/Documents/Codex/2026-10-18/wo');ck=root/'work/source-checkpoint-20261022/main-repo';base='b98025cb350a1e356458f5cdfc54f03f2afc20cf'
def git(p,*args):return subprocess.check_output(['git','-C',str(p),*args])
assert git(ck,'rev-parse','HEAD').decode().strip()==base and not git(ck,'status','--porcelain').strip()
out=ck/'checkpoints/decentralization-20261022/metal0-complete-custody-logs-20261024';assert not out.exists();entries=[]
def save(rel,b):
 b.decode('utf8');assert b'\0' not in b and len(b)<5000000;p=out/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);entries.append({'path':str(rel),'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)})
repo=root/'work/custody-v2-r2-production-canary-20261024';head=git(repo,'rev-parse','HEAD').decode().strip()
assert not git(repo,'diff','HEAD','--name-only').strip()
for name in git(repo,'ls-tree','-r','--name-only',head).decode().splitlines():save(Path('source')/name,git(repo,'show',head+':'+name))
save(Path('source/SOURCE-COMMIT.txt'),(head+'\n').encode())
for name in ['root-full-19.out','root-private-log-1.out','root-private-log-2.out','root-private-log-mutants-1.out','root-private-log-scan-2.guard']:save(Path('tests')/name,(repo/'logs'/name).read_bytes())
for name in ['metal0-normal-renewals-20261024.json','metal0-approved-funding-20261024.json','metal0-final-recovery-check-20261024.json']:save(Path('reports')/name,(root/'outputs/decentralization-audit'/name).read_bytes())
save(Path('capture.py'),Path(__file__).read_bytes())
(out/'MANIFEST.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousCheckpoint':base,'entries':entries,'status':'Metal0 restored; both original app-funded normal renewals independently verified with original guests healthy. Private bounded canary logging tested locally only. Full custody production matrix, restart recovery and rollback protection incomplete; no new custody activation.'},indent=2)+'\n');print(json.dumps({'entries':len(entries),'snapshot':str(out)}))
