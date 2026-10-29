from pathlib import Path
import subprocess,os
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
with (p/'generated-host-tests.log').open('x') as log:
 r=subprocess.run(['node','--test','--test-concurrency=1','--import',str(p/'test/helpers/baseline.mjs'),str(p/'test/root-schema3-host.test.mjs')],stdout=log,stderr=subprocess.STDOUT,timeout=90)
(p/'generated-host-tests.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)
