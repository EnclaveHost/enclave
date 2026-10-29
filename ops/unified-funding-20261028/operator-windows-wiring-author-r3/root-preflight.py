from pathlib import Path
import os,json,hashlib,subprocess,time
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
def sha(f):
 h=hashlib.sha256()
 with Path(f).open('rb') as s:
  for b in iter(lambda:s.read(1048576),b''):h.update(b)
 return h.hexdigest()
assert not (p/'attempt.json').exists()
prep=json.loads((p/'PREPARED.json').read_text())
assert sha(p/'PREPARED.json')=='183163f51ef3091ac53493653f2f4165e28a64d7c6b3879b36821ec0f8376e8d'
assert all(sha(p/n)==v for n,v in prep['hashes'].items())
pins=json.loads((p/'input-pins.json').read_text());assert len(pins)==13817
assert all(sha(n)==v for n,v in pins.items())
seed=json.loads((p/'seed-pins.json').read_text());assert len(seed)==249
assert all(sha(p/'candidate'/n)==v for n,v in seed.items())
assert {str(f.relative_to(p/'candidate')) for f in (p/'candidate').rglob('*') if f.is_file()}==set(seed)
b=prep['claudeExecutable'];assert sha(b['path'])==b['sha256']
a=json.loads(subprocess.check_output([b['path'],'auth','status'],text=True,timeout=20))
assert a.get('loggedIn') and a.get('email')=='steven.r.batchelor@gmail.com' and a.get('subscriptionType')=='max'
account={k:a.get(k) for k in ['loggedIn','email','subscriptionType']}
(p/'root-prelaunch-review.json').write_text(json.dumps({'reviewedAt':time.time(),'preparedHash':sha(p/'PREPARED.json'),'readonlyFiles':len(pins),'readonlyDrift':0,'candidateFiles':len(seed),'candidateDrift':0,'extraFiles':0,'account':account,'sourceOnlyOneLaunchApproved':True,'productionOrRemoteQualificationApproved':False},indent=2)+'\n')
print(json.dumps({'readonlyPins':len(pins),'candidateFiles':len(seed),'account':account,'oneSourceAuthorApproved':True}))
