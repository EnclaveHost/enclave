from pathlib import Path
import json,hashlib,time
from capture_local import capture
p=Path(__file__).resolve().parent;pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'disposableRootNamespace':True,'nativeSystemd':False,'productionData':False},f)
args=['/usr/sbin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--uid','0','--gid','0','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind',str(p/'frozen'),'/src','--ro-bind',str(p/'qualification-only'),'/qualification-only','--tmpfs','/etc','--tmpfs','/run','--tmpfs','/var','--tmpfs','/opt','--tmpfs','/sys','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chdir','/','--setenv','PATH','/usr/bin:/usr/sbin','--setenv','LANG','C','/usr/bin/python3','-B']
for name,path in [('ACTIVATION','test/rpc-guest/test_activate_storage.py'),('GUEST','test/rpc-guest/test_attach_storage.py')]:
 r=capture(args+['/src/'+path],25,limit=65536)
 (p/(name+'-RESULT.json')).write_text(json.dumps(r,indent=2)+'\n');verify()
 assert r['rc']==0 and not r['reason'] and not r['truncated'],name+' failed; see retained result'
(p/'RESULT.json').write_text(json.dumps({'allPass':True,'productionData':False,'nativeSystemd':False})+'\n')
