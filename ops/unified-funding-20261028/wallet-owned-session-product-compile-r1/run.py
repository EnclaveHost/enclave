# PREPARED ONLY; root reviews and admits one new invocation. No author, tests, FFI or deployment.
from pathlib import Path
import hashlib,json,os,subprocess,time,signal,re
p=Path(__file__).resolve().parent
def sha(f):
 h=hashlib.sha256()
 with Path(f).open('rb') as r:
  for b in iter(lambda:r.read(1048576),b''):h.update(b)
 return h.hexdigest()
def save(j):(p/'RESULT.json').write_text(json.dumps(j,indent=2)+'\n')
prep=json.loads((p/'PREPARED.json').read_text());approval=json.loads((p/'root-compile-approval.json').read_text())
if approval.get('launchAuthorized') is not True or approval.get('preparedSha256')!=sha(p/'PREPARED.json'):raise SystemExit('root admission missing/stale')
if os.sched_getaffinity(0)!={1}:raise SystemExit('exact CPU1 affinity required')
if os.readlink('/proc/self/ns/net')==prep['hostNetworkNamespace']:raise SystemExit('reviewed isolated network namespace required')
for rel,h in prep['hashes'].items():
 if sha(p/rel)!=h:raise SystemExit('prepared input drift '+rel)
pins=json.loads((p/'input-pins.json').read_text())
def drift():return [n for n,h in pins.items() if not Path(n).is_file() or sha(n)!=h]
if drift():raise SystemExit('source/tool/guard input drift')
origins=json.loads((p/'source-origins.json').read_text());inputjson=json.loads((p/'compiler-input.json').read_text())
if set(inputjson['sources'])!=set(origins):raise SystemExit('source inventory mismatch')
for rel,source in inputjson['sources'].items():
 if set(source)!={'content'} or source['content']!=(p/'seed'/rel).read_text():raise SystemExit('source transformation or URL import')
if list((p/'compile-cwd').iterdir()):raise SystemExit('compile cwd must be empty')
tmp=p/'owned-tmp'
if tmp.is_symlink() or not tmp.is_dir() or tmp.stat().st_uid!=os.getuid() or tmp.stat().st_mode&0o077:raise SystemExit('owned private temporary directory required')
with (p/'attempt.json').open('x') as f:json.dump({'pid':os.getpid(),'startedAt':time.time()},f)
solc='/home/steven/.local/share/svm/0.8.35/solc-0.8.35';argv=[solc,'--standard-json']
result={'status':'STARTED','argv':argv,'compilerSha256':sha(solc),'inputSha256':sha(p/'compiler-input.json'),'sourceFiles':3,'settings':inputjson['settings'],'executedTests':False,'networkIsolated':True,'sizeLimitsPass':False}
started=time.monotonic();proc=None
try:
 with (p/'compiler-input.json').open('rb') as inp,(p/'compiler-output.json').open('xb') as out,(p/'compiler-stderr.log').open('xb') as err:
  proc=subprocess.Popen(argv,stdin=inp,stdout=out,stderr=err,cwd=p/'compile-cwd',env={'PATH':'/usr/bin:/bin','TMPDIR':str(tmp)},start_new_session=True)
  result['compilerPid']=proc.pid;save(result)
  try:result['compilerExitCode']=proc.wait(timeout=600)
  except subprocess.TimeoutExpired:
   result['timedOut']=True;os.killpg(proc.pid,signal.SIGKILL);result['compilerExitCode']=proc.wait()
  finally:
   try:os.killpg(proc.pid,signal.SIGKILL)
   except ProcessLookupError:pass
 if result.get('timedOut') or result['compilerExitCode']!=0:result['status']='COMPILER_PROCESS_FAILED'
 else:
  output=json.loads((p/'compiler-output.json').read_text());errors=[e for e in output.get('errors',[]) if e.get('severity')=='error']
  result['diagnostics']=output.get('errors',[])
  if errors:result['status']='COMPILE_ERRORS'
  else:
   sizes={};ok=True
   targets=[('contracts/WalletSessionVault.sol','WalletSessionVault',6),('contracts/WalletSessionVault.sol','WalletSessionVaultFactory',5),('contracts/SessionVault.sol','SessionVaultLib',0)]
   for unit,name,args in targets:
    c=output['contracts'][unit][name];evm=c['evm'];creation=evm['bytecode']['object'];runtime=evm['deployedBytecode']['object']
    for body in [creation,runtime]:
     normalized=re.sub(r'__\$[0-9a-fA-F]{34}\$__','0'*40,body)
     if not normalized or len(normalized)%2 or re.search(r'[^0-9a-fA-F]',normalized):raise ValueError('malformed or missing bytecode '+name)
    sizes[name]={'runtimeBytes':len(runtime)//2,'creationBytes':len(creation)//2,'constructorBytes':args*32,'runtimeLinks':evm['deployedBytecode'].get('linkReferences',{}),'creationLinks':evm['bytecode'].get('linkReferences',{}),'immutableReferences':evm['deployedBytecode'].get('immutableReferences',{}),'metadataCompiler':json.loads(c['metadata']).get('compiler')}
    ok=ok and len(runtime)//2<=24576 and len(creation)//2+32*args<=49152
   result['sizes']=sizes;result['sizeLimitsPass']=ok;result['status']='COMPILE_AND_SIZE_PASS_UNTESTED' if ok else 'SIZE_LIMIT_FAILED'
except Exception as e:
 result['status']='RUNNER_OR_OUTPUT_ERROR';result['error']=str(e)
finally:
 result['inputDrift']=drift();result['elapsedSec']=round(time.monotonic()-started,3)
 result['outputSha256']=sha(p/'compiler-output.json') if (p/'compiler-output.json').exists() else None
 if result['inputDrift']:result['status']='INPUT_DRIFT'
 save(result)
raise SystemExit(0 if result['status']=='COMPILE_AND_SIZE_PASS_UNTESTED' else 1)
