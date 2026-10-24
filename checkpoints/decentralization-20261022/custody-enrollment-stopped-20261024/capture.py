from pathlib import Path
import subprocess,json,hashlib,datetime
root=Path('/home/steven/Documents/Codex/2026-10-18/wo');ck=root/'work/source-checkpoint-20261022/main-repo';base='5f820737361e248b9051ef9303e30109058a9151'
def git(p,*args):return subprocess.check_output(['git','-C',str(p),*args])
assert git(ck,'rev-parse','HEAD').decode().strip()==base and not git(ck,'status','--porcelain').strip()
out=ck/'checkpoints/decentralization-20261022/custody-enrollment-stopped-20261024';assert not out.exists();entries=[]
def save(rel,b):
 b.decode('utf8');assert b'\0' not in b and len(b)<5000000;p=out/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);entries.append({'path':str(rel),'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)})
repos=['custody-v2-r2-production-canary-20261024','custody-wallet-handoff-20261023','custody-operator-fees-20261023']
for folder in repos:
 repo=root/'work'/folder;head=git(repo,'rev-parse','HEAD').decode().strip()
 for name in git(repo,'ls-tree','-r','--name-only',head).decode().splitlines():save(Path('sources')/folder/name,git(repo,'show',head+':'+name))
 save(Path('sources')/folder/'SOURCE-COMMIT.txt',(head+'\n').encode())
repo=root/'work/custody-v2-current-docs-20261023';head=git(repo,'rev-parse','HEAD').decode().strip()
for name in ['CURRENT-STATE.md','README.md','SIGNING-AUTHORITY.md','SOURCES.md','ROLLBACK.md']:save(Path('docs')/name,git(repo,'show',head+':'+name))
save(Path('docs/SOURCE-COMMIT.txt'),(head+'\n').encode())
repo=root/'work/custody-v2-r2-production-canary-20261024'
for name in ['root-full-20.out','root-stopped-1.out','root-stopped-mutants-1.out','root-stopped-mutants-2.out','root-accept-handoff-tests.out','root-stopped-source-scans.guard']:save(Path('tests')/name,(repo/'logs'/name).read_bytes())
for name in ['metal0-owner-nomination-plan-20261024.json','metal0-owner-nomination-result-20261024.json','metal0-owner-accept-preflight-20261024.json','custody-book-current-20261024.json']:save(Path('reports')/name,(root/'outputs/decentralization-audit'/name).read_bytes())
save(Path('capture.py'),Path(__file__).read_bytes())
(out/'MANIFEST.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousCheckpoint':base,'entries':entries,'status':'Operator nomination confirmed, administrator acceptOwner pending at local handoff. Original factory book entry verified. Stopped-canary and recipient-preservation tooling tested locally, no production secret lifecycle or recovery launch. Original production apps/admin controls preserved.'},indent=2)+'\n');print(json.dumps({'entries':len(entries),'snapshot':str(out)}))
