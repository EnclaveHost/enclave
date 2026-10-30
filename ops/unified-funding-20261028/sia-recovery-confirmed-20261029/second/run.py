from pathlib import Path
import os,subprocess
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
with (p/'run.log').open('x') as out:
 try:
  r=subprocess.run(['node','--max-old-space-size=128',str(p/'read.mjs')],stdout=out,stderr=subprocess.STDOUT,timeout=100)
  rc=r.returncode
 except subprocess.TimeoutExpired:rc=124
(p/'run.rc').write_text(str(rc)+'\n')
raise SystemExit(rc)
