from pathlib import Path
import hashlib,json,time,os
from capture_local import capture
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
with (p/'ATTEMPT.json').open('x') as f: json.dump({'at':time.time(),'helpOnly':True},f)
files={'qemu-nbd':Path('/usr/sbin/qemu-nbd'),'nbd-client':p/'nbd-client'}
pins={n:hashlib.sha256(b.read_bytes()).hexdigest() for n,b in files.items()}
assert pins['nbd-client']=='0a256b67962d1ffc1ab8bacecd4319b8e459a0535467abb66f83329ce5221167'
results={}
for n,b in files.items():
 base=['/usr/sbin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind',str(b),'/tool','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/empty','--chdir','/empty','--setenv','HOME','/empty','--setenv','PATH','/usr/bin','--setenv','LANG','C']
 r=capture(base+['/tool','--help'],5,limit=65536);results[n]=r
 assert hashlib.sha256(b.read_bytes()).hexdigest()==pins[n]
(p/'RESULT.json').write_text(json.dumps({'at':time.time(),'pins':pins,'results':results,'networkNamespace':True,'databaseAvailable':False,'exportStarted':False},indent=2)+'\n')
print(json.dumps({n:{'rc':r['rc'],'reason':r['reason']} for n,r in results.items()}))
