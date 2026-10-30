from pathlib import Path
import subprocess,os
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
prior=p.parent/'lifecycle-host-authority-review-r2/test'
files=sorted((p/'test').glob('*.test.mjs'))+[x for x in sorted(prior.glob('*.test.mjs')) if x.name!='lifecycle-host-authority.test.mjs']
with (p/'combined-tests.log').open('x') as log:
 r=subprocess.run(['node','--test','--test-concurrency=1','--import',str(p/'test/helpers/baseline.mjs'),*map(str,files)],cwd=p,stdout=log,stderr=subprocess.STDOUT,timeout=180)
(p/'combined-tests.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)
