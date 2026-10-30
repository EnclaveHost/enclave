from pathlib import Path
import subprocess,os
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{1})
with (p/'build.log').open('x') as f:
 r=subprocess.run(['unshare','-Urn','node','--max-old-space-size=280',str(p/'build.mjs')],stdout=f,stderr=subprocess.STDOUT,cwd=p,timeout=180)
(p/'build.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)
