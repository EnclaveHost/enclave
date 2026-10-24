from pathlib import Path
import subprocess,json,hashlib,datetime
root=Path('/home/steven/Documents/Codex/2026-10-18/wo');ck=root/'work/source-checkpoint-20261022/main-repo'
base='356765d39dd4335120bdf986e90a6730865f0ac3'
def git(p,*a):return subprocess.check_output(['git','-C',str(p),*a])
assert git(ck,'rev-parse','HEAD').decode().strip()==base and not git(ck,'status','--porcelain').strip()
out=ck/'checkpoints/decentralization-20261022/custody-recipient-boots-20261024';assert not out.exists();entries=[]
def save(rel,b):
 b.decode('utf8');assert b'\0' not in b and len(b)<5000000;p=out/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);entries.append({'path':str(rel),'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)})
repo=root/'work/custody-v2-r2-production-canary-20261024';previous='195fe975279f365a1c06d13da686adae41bbcb3a'
previous=git(repo,'rev-parse',previous).decode().strip();head=git(repo,'rev-parse','HEAD').decode().strip()
assert head!=previous
changes=[]
for line in git(repo,'diff','--name-status',previous,head).decode().splitlines():
 status,name=line.split('\t');assert status in ['A','M'];changes.append({'status':status,'path':name});save(Path('sources/custody-v2-r2-production-canary-20261024')/name,git(repo,'show',head+':'+name))
save(Path('SOURCE-DELTA.json'),(json.dumps({'baseSnapshot':'../custody-log-intervals-20261024/SOURCE-DELTA.json','baseCommit':previous,'commit':head,'changes':changes,'restore':'Reconstruct the previous delta via its SOURCE-DELTA.json, then overlay every sources/custody-v2-r2-production-canary-20261024 file here. No tracked deletions.'},indent=2)+'\n').encode())
docs=root/'work/custody-v2-current-docs-20261023';dh=git(docs,'rev-parse','HEAD').decode().strip()
save(Path('docs/CURRENT-STATE.md'),git(docs,'show',dh+':CURRENT-STATE.md'));save(Path('docs/README.md'),git(docs,'show',dh+':README.md'));save(Path('docs/SIGNING-AUTHORITY.md'),git(docs,'show',dh+':SIGNING-AUTHORITY.md'));save(Path('docs/SOURCE-COMMIT.txt'),(dh+'\n').encode())
for name in ['root-full-29.out','root-full-30.out','root-recipient-attestation-full-2.guard','root-recipient-proof-full-1.guard','root-recipient-integrated-scan.guard']:
 save(Path('tests')/name,(repo/'logs'/name).read_bytes())
for name in ['runtime-resume-0940.json','host-resume-0940.json','recipient-manager-resume-0940.json']:
 save(Path('reports')/name,(repo/'logs'/name).read_bytes())
save(Path('capture.py'),Path(__file__).read_bytes())
(out/'MANIFEST.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousCheckpoint':base,'lastValidatedSourceCommit':head,'entries':entries,'status':'Fresh recipient SNP verification and TLS-pinned HMAC consumption integrated for new-committee releases. 173 Node/3 Python pass, known rollback TODO; real TLS transport fixtures but synthetic SNP/VM evidence. No production canary matrix executed. Metal0 acceptance remains pending at block53022685. Astra resource window coordinated, not taken; original apps and services preserved. Original source-committee and failed-boot/outage paths retain documented limitations. No decentralized custody or rollback-protection claim.'},indent=2)+'\n');print(json.dumps({'entries':len(entries),'sourceCommit':head,'snapshot':str(out)}))
