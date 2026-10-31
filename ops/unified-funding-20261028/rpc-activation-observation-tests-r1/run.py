from pathlib import Path
import json,hashlib,time,subprocess
from capture_local import capture
p=Path(__file__).resolve().parent;pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
verify()

s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(s.parent/'unified-funding-20261028/rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')

with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'disposableRootNamespace':True,'nativeSystemd':False,'productionData':False},f)
args=['/usr/sbin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--uid','0','--gid','0','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind',str(p/'frozen'),'/src','--ro-bind',str(p/'qualification-only'),'/qualification-only','--tmpfs','/etc','--tmpfs','/run','--tmpfs','/var','--tmpfs','/opt','--tmpfs','/sys','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chdir','/','--setenv','PATH','/usr/bin:/usr/sbin','--setenv','LANG','C','/usr/bin/python3','-B']
for name,path in [('OBSERVATION','test/rpc-guest/test_observe_activation.py'),('LAUNCH','test/rpc-guest/test_launch_activation.py'),('RUNTIME_DELIVERY','test/rpc-guest/test_deliver_runtime.py'),('RUNTIME','test/rpc-guest/test_start_runtime.py'),('DELIVERY','test/rpc-guest/test_deliver_activation.py'),('ACTIVATION','test/rpc-guest/test_activate_storage.py'),('GUEST','test/rpc-guest/test_attach_storage.py')]:
 r=capture(args+['/src/'+path],25,limit=65536)
 (p/(name+'-RESULT.json')).write_text(json.dumps(r,indent=2)+'\n');verify()
 assert r['rc']==0 and not r['reason'] and not r['truncated'],name+' failed; see retained result'
(p/'RESULT.json').write_text(json.dumps({'allPass':True,'productionData':False,'nativeSystemd':False})+'\n')
