from pathlib import Path
import subprocess,os
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
with (p/'root-before.log').open('x') as log:
 r=subprocess.run(['node','--test','--test-concurrency=1',str(p/'test/root-composition.test.mjs')],cwd=p,stdout=log,stderr=subprocess.STDOUT,timeout=60)
(p/'root-before.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)
