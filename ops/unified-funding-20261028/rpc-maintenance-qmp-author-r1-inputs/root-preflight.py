"""Root-admitted account/input check only; this file is never executed during preparation."""
from pathlib import Path
import hashlib,json,os,subprocess,sys,time
p=Path(__file__).resolve().parent
sha=lambda f:hashlib.sha256(Path(f).read_bytes()).hexdigest()
if len(sys.argv)!=2 or sys.argv[1]!=sha(p/'PREPARED.json'):raise SystemExit('root-reviewed exact PREPARED digest required')
expected=sys.argv[1];prep=json.loads((p/'PREPARED.json').read_text())
if os.sched_getaffinity(0)!={1}:raise SystemExit('exact CPU1 required')
for n,h in prep['hashes'].items():
 if sha(p/n)!=h:raise SystemExit('prepared drift: '+n)
pins=json.loads((p/'input-pins.json').read_text())
for n,h in pins.items():
 if not Path(n).is_file() or sha(n)!=h:raise SystemExit('readonly input drift: '+n)
seed=json.loads((p/'seed-pins.json').read_text())
if len(seed)!=prep['seedEntries']:raise SystemExit('seed count drift')
if set(seed)!={str(f.relative_to(p/'candidate')) for f in (p/'candidate').rglob('*') if f.is_file()}:raise SystemExit('candidate file set drift')
for n,h in seed.items():
 if sha(p/'candidate'/n)!=h or sha(p/'seed'/n)!=h:raise SystemExit('seed byte drift: '+n)
for n in ['attempt.json','started.json','claude.out','root-author-approval.json','root-preflight-result.json']:
 if (p/n).exists():raise SystemExit('prior admission/attempt evidence exists: '+n)
exe=Path(prep['claudeExecutable']['path'])
if not exe.is_absolute() or exe.is_symlink() or sha(exe)!=prep['claudeExecutable']['sha256']:raise SystemExit('reviewed executable drift')
active=[]
for d in Path('/proc').iterdir():
 if not d.name.isdigit():continue
 try:
  if d.stat().st_uid!=os.getuid():continue
 except FileNotFoundError:continue
 try:x=(d/'exe').resolve(strict=True)
 except FileNotFoundError:continue
 except PermissionError:raise SystemExit('process identity unreadable; root review required')
 if x==exe:active.append(int(d.name))
if active:raise SystemExit('reviewed Claude executable already active; coordinate, do not kill: '+str(active))
raw=json.loads(subprocess.check_output([str(exe),'auth','status'],text=True,timeout=20))
a={k:raw.get(k) for k in ['loggedIn','email','subscriptionType']}
if a!={'loggedIn':True,'email':'steven.r.batchelor@gmail.com','subscriptionType':'max'}:raise SystemExit('required current Max account unavailable; no retry or credential change')
record={'observedAt':time.time(),'preparedSha256':expected,'readonlyPins':len(pins),'seedEntries':len(seed),'inputDrift':[],'seedDrift':[],'account':a,'otherReviewedExecutableProcesses':active,'cpuAffinity':sorted(os.sched_getaffinity(0)),'authorLaunched':False,'apiRefreshProven':False}
with (p/'root-preflight-result.json').open('x') as f:json.dump(record,f,indent=2);f.write('\n')
print(json.dumps(record))
