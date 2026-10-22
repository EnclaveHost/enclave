from pathlib import Path
import json,hashlib,os,stat,shutil,datetime
base=Path('/home/steven/Documents/Codex/2026-10-18/wo')
p=base/'work/volume-model-main-integration'; main=base/'work/enclave'; worker=base/'work/model-volume-parity/tree'
d=json.loads((p/'inventory.json').read_text())
def state(f):
 if f.is_symlink():return {'symlink':os.readlink(f)}
 if not f.exists():return {'absent':True}
 return {'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'mode':oct(stat.S_IMODE(f.stat().st_mode))}
# The final worker changed exactly the one reviewed harness argument/comment.
changed=[r['path'] for r in d['paths'] if state(p/'staged'/r['path'])!=state(worker/r['path'])]
assert changed==['isolation/m3/test-domprobe-layers.sh'],changed
newpatch=base/'work/model-volume-parity/model-delta.patch'
assert hashlib.sha256(newpatch.read_bytes()).hexdigest()=='ea179b273ad63f6531e2d62a8ad9e8773cc83469e8dcbc583d670305596a90d8'
assert hashlib.sha256((base/'work/volume-parity/delta.patch').read_bytes()).hexdigest()=='3b43ce9bc9eb60bea063ddb1d7e5937a344687de8acc66d36d5be81ff3c42941'
# Refuse any unreviewed main drift before any write.
for r in d['paths']:assert state(main/r['path'])==r['mainBefore'],r['path']
shutil.copy2(worker/changed[0],p/'staged'/changed[0]);shutil.copy2(newpatch,p/'input-1-final.patch')
for r in d['paths']:
 src=p/'staged'/r['path'];dst=main/r['path']
 assert state(src)==state(worker/r['path']),r['path']
 assert state(dst)==r['mainBefore'],r['path']
 dst.parent.mkdir(parents=True,exist_ok=True)
 tmp=dst.with_name(dst.name+'.root-integration-tmp')
 assert not tmp.exists() and not tmp.is_symlink()
 if src.is_symlink():tmp.symlink_to(os.readlink(src))
 else:shutil.copy2(src,tmp)
 os.replace(tmp,dst)
 r['staged']=state(src)
for r in d['paths']:assert state(main/r['path'])==r['staged'],r['path']
now=datetime.datetime.now(datetime.timezone.utc).isoformat()
d.update(at=now,status='integrated in main source; hardware activation pending',mainModified=True)
d['patches'][1]['sha256']=hashlib.sha256(newpatch.read_bytes()).hexdigest()
(p/'inventory.json').write_text(json.dumps(d,indent=2)+'\n')
audit={'at':now,'status':d['status'],'sourceInventory':'work/volume-model-main-integration/inventory.json','uniquePaths':len(d['paths']),'workerTreeMismatches':0,'mainModified':True,'sourcePatches':[x['source'] for x in d['patches']],'evidence':['work/model-volume-parity/logs/final-v1.log','work/model-volume-parity/logs/domprobe-v1.log'],'validation':'Exact 98 composed paths match tested worker bytes/modes. Prior final batch passed model JS/Go/kernel/runtime checks but failed old domprobe harness; final targeted corrected harness passed real probe and all three mutants. No broad clean-suite claim.','productionActivated':False,'pending':['Compose other workers overlapping source hunks without overwriting these files.','Actual SNP/Hyper-V model/volume hardware acceptance and controlled release activation.']}
(base/'outputs/decentralization-audit/volume-model-composition.json').write_text(json.dumps(audit,indent=2)+'\n')
print('Integrated and byte/mode verified',len(d['paths']),'paths; production unchanged.')
