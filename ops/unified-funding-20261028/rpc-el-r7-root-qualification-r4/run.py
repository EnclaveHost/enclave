from pathlib import Path
import json,subprocess,time,os
p=Path(__file__).resolve().parent;s=p.parent/'rpc-control-vm-l1-client-root-r7-repaired-r2'
assert os.sched_getaffinity(0)=={1}
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'sourceOnly':True,'native':False},f)
r=subprocess.run(['/usr/bin/python3','-B',str(p/'baseline-race.py')],capture_output=True,text=True,timeout=10)
(p/'baseline-race-result.json').write_text(json.dumps({'rc':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2)+'\n')
assert r.returncode==1 and 'watchdog-deadline' in r.stderr and 'bounded-trial-finished' in r.stderr
for name in ['check-source.py','assemble.py','check-runtime.py']:
 r=subprocess.run(['/usr/bin/python3','-B',str(s/name)],capture_output=True,text=True,timeout=40)
 (p/(name+'.json')).write_text(json.dumps({'rc':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2)+'\n')
 assert r.returncode==0,name
print('source checks, pure assembly and actual owned-process/runtime composition fixtures PASS')
