from pathlib import Path
import os,subprocess,json,hashlib
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
for f,h in json.loads((p/'pins.json').read_text()).items():assert hashlib.sha256(Path(f).read_bytes()).hexdigest()==h,f
env=dict(os.environ,LIFECYCLE_REVIEW_R2=str(p.parent/'lifecycle-host-authority-review-r2'))
with (p/'result.log').open('x') as f:r=subprocess.run(['unshare','-Urn','node','--test','--experimental-test-isolation=none','--test-concurrency=1','--import',str(p/'test/helpers/baseline.mjs'),str(p/'test/root-final-await.test.mjs')],env=env,stdout=f,stderr=subprocess.STDOUT,timeout=60)
for f,h in json.loads((p/'pins.json').read_text()).items():assert hashlib.sha256(Path(f).read_bytes()).hexdigest()==h,f
(p/'result.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)
