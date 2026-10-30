from pathlib import Path
import subprocess,os,json
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
results=[]
for label,cmd in [('tests',['node','--test','--test-concurrency=1',str(p/'topup.test.mjs')]),('build',['node',str(p/'build-candidate.mjs')])]:
 with (p/(label+'.log')).open('x') as log:r=subprocess.run(cmd,cwd=p,stdout=log,stderr=subprocess.STDOUT,timeout=90)
 results.append({'step':label,'exitCode':r.returncode})
 if r.returncode:break
(p/'results.json').write_text(json.dumps(results,indent=2)+'\n')
raise SystemExit(r.returncode)
