from pathlib import Path
import subprocess,json,hashlib,datetime
ROOT=Path('/home/steven/Documents/Codex/2026-10-18/wo');CK=ROOT/'work/source-checkpoint-20261022/main-repo';R=ROOT/'work/custody-operator-funding-options-20261023'
def git(r,*a):return subprocess.check_output(['git','-C',str(r),*a])
BASE='abaf31cf280ce7a73c2444fb3976ccc3b14e44d8';HEAD='7000b6725791faa1abaa5bbb7a71c0c0d570045e';OUT=CK/'checkpoints/decentralization-20261022/metal0-funding-inventory-20261024-0345'
assert git(CK,'rev-parse','HEAD').decode().strip()==BASE and not git(CK,'status','--porcelain').strip();assert git(R,'rev-parse','HEAD').decode().strip()==HEAD and not git(R,'status','--porcelain','--untracked-files=no').strip();assert not OUT.exists();entries=[]
def save(rel,b,origin):
 assert b'\0' not in b and len(b)<1000000;b.decode();p=OUT/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);entries.append({'path':rel,'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'origin':origin})
for p in ['lib/protected-inventory.mjs','bin/prepare.mjs','bin/root-send.mjs','test/protected-inventory.test.mjs','ROOT-OPERATIONS.md']:save('source/'+p,git(R,'show',HEAD+':'+p),'work/custody-operator-funding-options-20261023@'+HEAD+':'+p)
save('evidence/protected-inventory-1.out',(R/'logs/protected-inventory-1.out').read_bytes(),'work/custody-operator-funding-options-20261023/logs/protected-inventory-1.out')
save('preserve-funding.sh',(ROOT/'work/metal0-expired-recovery-20261024/preserve-funding.sh').read_bytes(),'work/metal0-expired-recovery-20261024/preserve-funding.sh')
save('capture.py',Path(__file__).read_bytes(),'work/resume-after-checkpoint-20261022/source-preservation/capture-funding-inventory-0345.py')
(OUT/'MANIFEST.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousCheckpoint':BASE,'source':HEAD,'subset':True,'entries':entries,'status':'Source guard correction only. Both protected IDs mandatory for preparation and NEW signing; existing journal resume unaffected. No production funding or delegation change.'},indent=2)+'\n');print(json.dumps({'files':len(entries),'path':str(OUT)}))
