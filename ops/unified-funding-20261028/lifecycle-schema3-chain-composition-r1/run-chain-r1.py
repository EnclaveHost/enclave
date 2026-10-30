from pathlib import Path
import subprocess,os
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
env={k:os.environ[k] for k in ['PATH','HOME','USER','LANG'] if k in os.environ}
with (p/'dispatch-r1.log').open('x') as log:
 r=subprocess.run(['timeout','-k','10','650','unshare','-Urn','bash',str(p/'run-chain-r1.sh')],cwd=p,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=680)
(p/'dispatch-r1.rc').write_text(str(r.returncode)+'\n')
raise SystemExit(r.returncode)
