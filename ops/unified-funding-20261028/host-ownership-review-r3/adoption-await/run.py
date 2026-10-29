from pathlib import Path
import os,subprocess,json,hashlib
p=Path(__file__).resolve().parent;u=p.parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
m=json.loads((p/'pins.json').read_text())
def check():
 for f,h in m.items():assert hashlib.sha256(Path(f).read_bytes()).hexdigest()==h,f
check();env=dict(os.environ,LIFECYCLE_REVIEW_R2=str(u/'lifecycle-host-authority-review-r2'))
for name in ['before','after']:
 d=p/name;out=d/'generated';out.mkdir()
 with (d/'generate.log').open('x') as f:subprocess.run(['unshare','-Urn','node',str(d/'generator.mjs'),str(u/'host-registry-repair-root-review-r3/src/network'),str(out)],stdout=f,stderr=subprocess.STDOUT,check=True,timeout=10)
 (d/'src/network/lifecycle-host-dispatch.mjs').write_bytes((out/'lifecycle-host-dispatch.mjs').read_bytes())
 with (d/'result.log').open('x') as f:r=subprocess.run(['unshare','-Urn','node','--test','--experimental-test-isolation=none','--test-concurrency=1','--import',str(d/'test/helpers/baseline.mjs'),str(d/'test/root-final-await.test.mjs')],stdout=f,stderr=subprocess.STDOUT,env=env,timeout=40)
 (d/'result.rc').write_text(str(r.returncode)+'\n')
check()
