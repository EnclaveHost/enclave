from pathlib import Path
import hashlib,json,subprocess,os,time
p=Path(__file__).resolve().parent
def sha(f):
 h=hashlib.sha256()
 with Path(f).open('rb') as s:
  for b in iter(lambda:s.read(1048576),b''):h.update(b)
 return h.hexdigest()
expected='4890dc0b971a3c718934bbdeffbde05493ddd99e15af72bb5015eb633d644b1d'
assert sha(p/'PREPARED.json')==expected
prep=json.loads((p/'PREPARED.json').read_text())
assert all(sha(p/n)==h for n,h in prep['hashes'].items())
pins=json.loads((p/'input-pins.json').read_text());assert len(pins)==772
assert all(Path(n).is_file() and sha(n)==h for n,h in pins.items())
seed=json.loads((p/'seed-pins.json').read_text());assert len(seed)==227
assert all(sha(p/'candidate'/n)==h for n,h in seed.items())
assert set(seed)=={str(f.relative_to(p/'candidate')) for f in (p/'candidate').rglob('*') if f.is_file()}
assert not any((p/n).exists() for n in ['attempt.json','started.json','claude.out','root-author-approval.json'])
exe=Path(prep['claudeExecutable']['path']);assert not exe.is_symlink() and sha(exe)==prep['claudeExecutable']['sha256']
assert os.sched_getaffinity(0)=={1}
active=[]
for q in Path('/proc').iterdir():
 if not q.name.isdigit():continue
 try:
  if (q/'exe').resolve(strict=True)!=exe:continue
  cwd=(q/'cwd').resolve(strict=True)
  active.append({'pid':int(q.name),'cwd':str(cwd)})
  assert cwd!=p and not cwd.is_relative_to(p)
 except (FileNotFoundError,PermissionError):continue
raw=json.loads(subprocess.check_output([str(exe),'auth','status'],text=True,timeout=20))
a={k:raw.get(k) for k in ['loggedIn','email','subscriptionType']}
assert a=={'loggedIn':True,'email':'steven.r.batchelor@gmail.com','subscriptionType':'max'}
report={'time':time.time(),'preparedSha256':expected,'readonlyPins':len(pins),'seedEntries':len(seed),'inputDrift':[],'seedDrift':[],'account':a,'otherExactExecutableProcesses':active,'cpuAffinity':sorted(os.sched_getaffinity(0)),'sourceOnly':True}
(p/'root-preflight-result.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
