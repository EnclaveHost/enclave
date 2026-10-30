# PREPARED ONLY. Root reviews/admission first. No code is executed during preparation.
from pathlib import Path
import os,json,hashlib,shutil,subprocess,time,signal
p=Path(__file__).resolve().parent
if os.sched_getaffinity(0)!={1}:raise SystemExit('CPU1 affinity required')
def sha(f):
 h=hashlib.sha256()
 with Path(f).open('rb') as r:
  for b in iter(lambda:r.read(1048576),b''):h.update(b)
 return h.hexdigest()
def save(n,j):(p/n).write_text(json.dumps(j,indent=2)+'\n')
prep=json.loads((p/'PREPARED.json').read_text());approval=json.loads((p/'root-test-approval.json').read_text())
if approval.get('launchAuthorized') is not True or approval.get('preparedSha256')!=sha(p/'PREPARED.json'):raise SystemExit('missing/stale root admission')
for rel,h in prep['hashes'].items():
 if sha(p/rel)!=h:raise SystemExit('prepared file drift '+rel)
pins=json.loads((p/'input-pins.json').read_text())
def drift():return [n for n,h in pins.items() if not Path(n).is_file() or sha(n)!=h]
if drift():raise SystemExit('input drift')
seed=json.loads((p/'seed-pins.json').read_text())
if {str(f.relative_to(p/'seed')):sha(f) for f in (p/'seed').rglob('*') if f.is_file()}!=seed:raise SystemExit('seed inventory drift')
# PID1 namespace is unreadable to this user. Root preflight must confirm this pinned host namespace.
if os.readlink('/proc/self/ns/net')==prep['hostNetworkNamespace']:raise SystemExit('isolated network namespace required')
with (p/'attempt.json').open('x') as f:json.dump({'pid':os.getpid(),'startedAt':time.time()},f)
run=p/'run';shutil.copytree(p/'seed',run)
tmp=p/'owned-tmp'
if tmp.is_symlink() or tmp.stat().st_uid!=os.getuid() or tmp.stat().st_mode&0o077:raise SystemExit('private owned tmp required')
forge='/home/steven/.foundry/bin/forge';solc='/home/steven/.local/share/svm/0.8.35/solc-0.8.35'
env={'PATH':'/usr/bin:/bin','TMPDIR':str(tmp),'FOUNDRY_CONFIG':str(run/'foundry.toml'),'FOUNDRY_PROFILE':'default','RAYON_NUM_THREADS':'1'}
result={'status':'STARTED','executed':[],'sourcePins':len(pins),'networkIsolated':True,'settings':prep['settings'],'testsRun':False,'compilePassed':False,'sizeGatePassed':False,'sourceDrift':[]}
started=time.monotonic()
def invoke(label,argv,seconds):
 with (p/(label+'.log')).open('x') as out:
  proc=subprocess.Popen(argv,cwd=run,env=env,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
  timed=False
  try:rc=proc.wait(timeout=min(seconds,max(1,900-(time.monotonic()-started))))
  except subprocess.TimeoutExpired:
   timed=True;os.killpg(proc.pid,signal.SIGKILL);rc=proc.wait()
  finally:
   # All children belong to this invocation's dedicated process group; never touch other jobs.
   try:os.killpg(proc.pid,signal.SIGKILL)
   except ProcessLookupError:pass
 result['executed'].append({'label':label,'argv':argv,'rc':rc,'timedOut':timed});save('RESULT.json',result)
 return rc==0 and not timed
common=['--root',str(run),'--offline','--use',solc,'--threads','1']
try:
 if invoke('compile-sizes',[forge,'build',*common,'--sizes'],720):
  result['compilePassed']=True;sizes={};ok=True
  for unit,name,args in [('WalletSessionVault.sol','WalletSessionVault',6),('WalletSessionVault.sol','WalletSessionVaultFactory',5),('SessionVault.sol','SessionVaultLib',0)]:
   f=run/'out'/unit/(name+'.json')
   a=json.loads(f.read_text());creation=a['bytecode']['object'].removeprefix('0x');runtime=a['deployedBytecode']['object'].removeprefix('0x')
   sizes[name]={'creationBytes':len(creation)//2,'constructorBytes':args*32,'runtimeBytes':len(runtime)//2,'linkReferences':a['bytecode'].get('linkReferences',{}),'artifactSha256':sha(f)}
   ok=ok and len(runtime)//2<=24576 and len(creation)//2+args*32<=49152
  result['sizes']=sizes;result['sizeGatePassed']=ok
  if ok:
   result['testsRun']=True
   result['testsPassed']=invoke('new-tests',[forge,'test',*common,'--match-contract','WalletSessionVault(Test|Rev16DTest)','-vv'],180)
  else:result['status']='SIZE_GATE_FAILED_NO_TESTS'
 else:result['status']='COMPILE_FAILED_NO_TESTS'
finally:
 result['sourceDrift']=drift()
 result['runSourceChanged']=[n for n,h in seed.items() if not (run/n).is_file() or sha(run/n)!=h]
 result['elapsedSec']=round(time.monotonic()-started,3)
 if result['status']=='STARTED':result['status']='PASS' if result.get('testsPassed') and not result['sourceDrift'] and not result['runSourceChanged'] else 'FAILED'
 save('RESULT.json',result)
raise SystemExit(0 if result['status']=='PASS' else 1)
