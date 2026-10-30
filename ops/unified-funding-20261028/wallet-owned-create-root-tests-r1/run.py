from pathlib import Path
import os,subprocess,json,hashlib,tempfile,shutil
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
def check():
 for n,h in json.loads((p/'source-pins.json').read_text()).items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
 for n,h in json.loads((p/'dependency-pins.json').read_text()).items():assert hashlib.sha256(Path(n).read_bytes()).hexdigest()==h,n
check();tmp=Path(tempfile.mkdtemp(prefix='wallet-create-test-',dir=str(p)));(p/'temp-dir.json').write_text(json.dumps({'path':str(tmp),'owned':True}))
env={'PATH':'/usr/bin:/bin','HOME':str(tmp),'TMPDIR':str(tmp),'TEST_TMPDIR':str(tmp)}
try:
 with (p/'result.tap').open('x') as out:
  r=subprocess.run(['/usr/bin/unshare','-Urn','/usr/bin/node','--max-old-space-size=180','--test','--test-concurrency=1','--test-timeout=60000',str(p/'candidate/enclave/test/wallet-session/root-discovery.test.mjs')],env=env,cwd=p/'candidate/enclave',stdout=out,stderr=subprocess.STDOUT,timeout=90)
 check();(p/'result.rc').write_text(str(r.returncode)+'\n')
finally:
 (p/'remaining-test-files.json').write_text(json.dumps([str(x.relative_to(tmp)) for x in tmp.rglob('*')]))
 shutil.rmtree(tmp)
raise SystemExit(r.returncode)
