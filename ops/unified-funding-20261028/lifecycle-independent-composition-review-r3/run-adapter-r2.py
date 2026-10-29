from pathlib import Path
import subprocess,os
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
env={k:os.environ[k] for k in ['PATH','HOME','USER','LANG'] if k in os.environ}
with (p/'adapter-dispatch-r2.log').open('x') as log:
 r=subprocess.run(['timeout','-k','10','560','unshare','-Urn','bash',str(p/'run-adapter-r2.sh')],cwd=p,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=600)
(p/'adapter-dispatch-r2.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)
