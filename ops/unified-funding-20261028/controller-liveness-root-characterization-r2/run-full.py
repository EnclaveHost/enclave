from pathlib import Path
import json,hashlib,os,subprocess,tempfile,shutil,time,resource
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
def check():
 for r in json.loads((p/'BASELINE-SEAM-PINS.json').read_text())+json.loads((p/'CANDIDATE-SOURCE-PINS.json').read_text())+json.loads((p/'NODE-DEPENDENCIES.json').read_text())['files']:
  with open(r['path'],'rb') as f: assert hashlib.file_digest(f,'sha256').hexdigest()==r['sha256'],r['path']
 for r in json.loads((p/'NODE-DEPENDENCIES.json').read_text())['symlinks']:assert os.readlink(r['path'])==r['target'] and str(Path(r['path']).resolve())==r['realpath']
check()
with (p/'FULL-ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'scope':'three actual liveness consumers, diagnostic partial source'},f)
resource.setrlimit(resource.RLIMIT_FSIZE,(32<<20,32<<20))
tmp=Path(tempfile.mkdtemp(prefix='controller-liveness-tests-',dir='/vm/enclave-volumes/rpc-production-maint'))
(p/'FULL-TEMP.json').write_text(json.dumps({'path':str(tmp),'inode':tmp.stat().st_ino}))
env={'PATH':'/usr/bin:/bin','HOME':str(tmp),'TMPDIR':str(tmp),'TEST_TMPDIR':str(tmp),'PYTHONDONTWRITEBYTECODE':'1'}
results=[]
try:
 for name,dir,files,pattern,timeout in [
  ('baseline','baseline-with-seam',['test/isolation-instance-liveness.test.mjs'],'^(held resume:.*\\(timeout\\)|audit:.*\\(timeout\\)|billing:.*\\(timeout\\))',110),
  ('candidate','candidate',['test/isolation-instance-liveness.test.mjs','test/claim-sweep.test.mjs','test/isolation-guest-pool.test.mjs','test/isolation-post-adoption-lease.test.mjs','test/isolation-resume-shield-model.test.mjs','test/tenant-lease.test.mjs'],None,650)]:
  args=['/usr/bin/unshare','-Urn','/usr/bin/node','--max-old-space-size=180','--test','--test-concurrency=1','--test-timeout=60000']
  if pattern:args.append('--test-name-pattern='+pattern)
  args+=files
  with (p/('full-'+name+'.tap')).open('x') as out:
   r=subprocess.run(args,cwd=p/dir,env=env,stdout=out,stderr=subprocess.STDOUT,timeout=timeout)
  results.append({'name':name,'rc':r.returncode,'at':time.time()})
 check()
 (p/'FULL-RESULT.json').write_text(json.dumps({'runs':results,'inputsUnchanged':True,'productionChanged':False})+'\n')
finally:shutil.rmtree(tmp)
raise SystemExit(0 if results[0]['rc']==1 and results[1]['rc']==0 else 1)
