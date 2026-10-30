from pathlib import Path
import hashlib,json,os,shutil,subprocess,tempfile,time
p=Path(__file__).resolve().parent;assert os.sched_getaffinity(0)=={1}
a=json.loads((p/'INPUTS.json').read_text());sha=lambda f:hashlib.sha256(Path(f).read_bytes()).hexdigest()
def check():
 for x in json.loads((p/'TOOLS.json').read_text()):assert sha(x['path'])==x['sha256']
 for x in a.values():assert sha(x['path'])==x['sha256']
check()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'scope':'original frozen source unit fixtures plus two root integration regressions'},f)
t=Path(tempfile.mkdtemp(prefix='rpc-writer-tests-'));(p/'TEMP.json').write_text(json.dumps({'path':str(t)}));rc=1
try:
 for n,x in a.items():shutil.copy2(x['path'],t/n)
 with (p/'output.txt').open('x') as out:
  try:rc=subprocess.run(['/usr/bin/unshare','-Urn','/usr/bin/python3','-B','harness.py',str(p/'RESULT.json')],cwd=t,env={'PATH':'/usr/bin:/bin','HOME':str(t),'TMPDIR':str(t),'PYTHONDONTWRITEBYTECODE':'1'},stdout=out,stderr=subprocess.STDOUT,timeout=40).returncode
  except subprocess.TimeoutExpired:rc=124
 for n,x in a.items():assert sha(t/n)==x['sha256']
 check()
finally:
 shutil.rmtree(t);(p/'result.rc').write_text(str(rc)+'\n')
raise SystemExit(rc)
