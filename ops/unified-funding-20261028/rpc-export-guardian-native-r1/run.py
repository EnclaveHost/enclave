from pathlib import Path
import os,json,time,hashlib
from capture_local import capture
p=Path(__file__).resolve().parent
pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'privateDummyOnly':True,'productionData':False},f)
args=['/usr/sbin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--uid','0','--gid','0','--cap-add','CAP_NET_ADMIN','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind',str(p/'frozen'),'/src','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chdir','/','--setenv','HOME','/tmp','--setenv','PATH','/usr/bin:/usr/sbin','--setenv','LANG','C','/usr/bin/python3','-B','/src/test/rpc-server/qualify_volume_export.py']
prefix=args[:-3]
syntax=capture(prefix+['/usr/bin/node','--check','/src/rpc/server/observe_resources.mjs'],10,limit=65536)
(p/'SYNTAX.json').write_text(json.dumps(syntax,indent=2)+'\n');assert syntax['rc']==0 and not syntax['reason']
tests=capture(prefix+['/usr/bin/python3','-B','/src/test/rpc-server/test_guarded_export.py'],20,limit=65536)
(p/'GUARD-RESULT.json').write_text(json.dumps(tests,indent=2)+'\n');assert tests['rc']==0 and not tests['reason']
r=capture(args,75,limit=131072);(p/'RESULT.json').write_text(json.dumps(r,indent=2)+'\n');verify();assert r['rc']==0 and not r['reason'] and not r['truncated'],r
