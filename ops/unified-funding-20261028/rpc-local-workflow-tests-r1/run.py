from pathlib import Path
import json,subprocess,os,hashlib,time
from capture_local import capture
p=Path(__file__).resolve().parent;f=p/'frozen'
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
config=s.parent/'unified-funding-20261028/rpc-export-current-admission-read-r2/CONFIG.json'
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(config)],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
env=dict(os.environ,RPC_TEST_ROOT=str(p/'private'),PYTHONDONTWRITEBYTECODE='1');results=[]
for name in ('test_run_startup.py','test_local_guest_workflow.py','test_deliver_guest_workflow.py'):
 r=capture(['/usr/bin/env','RPC_TEST_ROOT='+str(p/'private'),'PYTHONDONTWRITEBYTECODE=1','/usr/bin/python3','-B',str(f/'test'/('rpc-server' if name=='test_run_startup.py' else 'rpc-guest')/name)],25,limit=65536)
 (p/(name+'.result.json')).write_text(json.dumps(r,indent=2)+'\n')
 results.append({'name':name,'rc':r['rc'],'seconds':r['elapsedSeconds']})
 if r['rc'] or r['reason'] or r['truncated']:break

args=['/usr/sbin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--uid','0','--gid','0','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind',str(f),'/src','--ro-bind',str(p/'qualification-only'),'/qualification-only','--tmpfs','/etc','--tmpfs','/run','--tmpfs','/var','--tmpfs','/opt','--tmpfs','/sys','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chdir','/','--setenv','PATH','/usr/bin:/usr/sbin','--setenv','LANG','C','/usr/bin/python3','-B','/src/test/rpc-guest/test_transfer_export.py']
if all(x['rc']==0 for x in results):
 r=capture(args,25,limit=65536)
 (p/'test_transfer_export.py.result.json').write_text(json.dumps(r,indent=2)+'\n')
 results.append({'name':'test_transfer_export.py','rc':r['rc'],'seconds':r['elapsedSeconds']})

drift=[]
for row in json.loads((p/'PINS.json').read_text()):
 if hashlib.sha256((f/row['path']).read_bytes()).hexdigest()!=row['sha256']:drift.append(row['path'])
(p/'RESULT.json').write_text(json.dumps({'tests':results,'drift':drift},indent=2)+'\n')
assert not drift and all(x['rc']==0 for x in results)
