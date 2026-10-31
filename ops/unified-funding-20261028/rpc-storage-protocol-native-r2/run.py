from pathlib import Path
import json,hashlib,time
from capture_local import capture
p=Path(__file__).resolve().parent;pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'privateSparseDummyOnly':True,'productionData':False},f)
args=['/usr/sbin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--uid','0','--gid','0','--cap-add','CAP_NET_ADMIN','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind',str(p/'frozen'),'/src','--ro-bind',str(p/'fixture-etc'),'/etc','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chdir','/','--setenv','HOME','/work','--setenv','PATH','/usr/bin:/usr/sbin','--setenv','LANG','C','/usr/bin/python3','-B']
results={}
for name,path,seconds in [('PROTOCOL','test/rpc-server/test_storage_protocol.py',15),('GUEST','test/rpc-guest/test_attach_storage.py',15),('GUARD','test/rpc-server/test_guarded_export.py',20),('NATIVE','test/rpc-server/qualify_storage_protocol.py',45)]:
 r=capture(args+['/src/'+path],seconds,limit=65536);results[name]=r
 (p/(name+'-RESULT.json')).write_text(json.dumps(r,indent=2)+'\n');verify()
 assert r['rc']==0 and not r['reason'] and not r['truncated'],name+' failed; see bounded public result'
(p/'RESULT.json').write_text(json.dumps({'allPass':True,'tests':list(results),'productionData':False})+'\n')
