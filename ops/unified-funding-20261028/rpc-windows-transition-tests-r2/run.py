from pathlib import Path
import json,subprocess,os,hashlib,time
p=Path(__file__).resolve().parent;f=p/'frozen'
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
config=s.parent/'unified-funding-20261028/rpc-export-current-admission-read-r2/CONFIG.json'
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(config)],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
env=dict(os.environ,RPC_TEST_ROOT=str(p/'private'),PYTHONDONTWRITEBYTECODE='1');results=[]
for name in ('test_windows_transition.py','test_windows_clock_transport.py'):
 start=time.monotonic()
 with (p/(name+'.log')).open('x') as log:r=subprocess.run(['/usr/bin/python3','-B',str(f/'test/rpc-server'/name)],stdout=log,stderr=subprocess.STDOUT,env=env,timeout=45)
 results.append({'name':name,'rc':r.returncode,'seconds':time.monotonic()-start})
 if r.returncode:break
drift=[]
for row in json.loads((p/'PINS.json').read_text()):
 if hashlib.sha256((f/row['path']).read_bytes()).hexdigest()!=row['sha256']:drift.append(row['path'])
(p/'RESULT.json').write_text(json.dumps({'tests':results,'drift':drift},indent=2)+'\n')
assert not drift and all(x['rc']==0 for x in results)
