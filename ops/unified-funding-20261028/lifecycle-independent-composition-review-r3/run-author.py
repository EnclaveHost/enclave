from pathlib import Path
import subprocess,os
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
with (p/'author-tests.log').open('x') as log:
 r=subprocess.run(['node','--test','--test-concurrency=1','--import',str(p/'test/helpers/baseline.mjs'),*map(str,sorted((p/'test').glob('*.test.mjs')))],cwd=p,stdout=log,stderr=subprocess.STDOUT,timeout=180)
(p/'author-tests.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)
